// Competitor and ranking alerts: rules that turn tracker snapshots and rank checks into alerts,
// an in-app feed (JSON store) and optional delivery to Telegram, Discord, Slack or any JSON webhook.
//
// Stores:  'alerts'          feed, newest first (max MAX_ALERTS)
//          'alerts-settings' user settings (see defaultSettings)
//          'alerts-seen'     { dedupeKey: firstSeenMs } so restarts and replays never resend
import { randomUUID } from 'node:crypto';
import { median } from './analytics.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const MAX_ALERTS = 500;
export const BREAKOUT_COOLDOWN_MS = 7 * DAY; // at most one breakout alert per video per 7 days
// Breakouts need this much history: gains measured over minutes and extrapolated to a day are noise.
// Same window the tracker uses for its "trending" list (src/tracker.js channelReport).
export const BREAKOUT_MIN_SPAN_MS = 12 * HOUR;
// Videos younger than this are judged on total views vs the channel's typical video, not on views/day,
// because every video gets most of its views in its first days.
export const YOUNG_VIDEO_MS = 7 * DAY;
const MIN_PEER_VIDEOS = 3; // fewer established videos of the same format: no fair "typical" to compare with
const SEEN_MAX_AGE_MS = 400 * DAY;
const SEEN_MAX_KEYS = 20_000;
const MAX_UPLOADS_PER_SNAPSHOT = 10; // e.g. after the server was off for weeks: alert on the newest ones only
const TITLE_MAX = 200;

// Platform limits (verified against official docs):
//   Telegram sendMessage `text`: 1-4096 characters      https://core.telegram.org/bots/api#sendmessage
//   Discord Execute Webhook `content`: up to 2000 chars  https://docs.discord.com/developers/resources/webhook
// Slack documents no length limit for incoming webhooks; TEXT_CAP is our own safety cap (alerts are short).
export const TELEGRAM_MAX = 4096;
export const DISCORD_MAX = 2000;
export const TEXT_CAP = 3500;
const TEST_COOLDOWN_MS = 5000;

/** Subscriber milestones: 1K, then 1x and 5x every power of ten from 10K (10K, 50K, 100K, 500K, 1M, 5M ...). */
export const MILESTONES = [1e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6, 1e7, 5e7, 1e8, 5e8, 1e9];

export const defaultSettings = () => ({
  types: { upload: true, breakout: true, milestone: true, rank: true },
  breakoutRatio: 3, // views/day at least this many times the channel's typical video
  breakoutMinViewsPerDay: 1000,
  rankMoveThreshold: 5, // places
  delivery: { telegram: true, webhook: true }, // only used when the channel is configured in the environment
});

// The Tracking tab only lists trending videos at >= 2x typical and >= 50 views/day, so lower values would do nothing.
const LIMITS = {
  breakoutRatio: { min: 2, max: 1000, int: false, label: 'Breakout ratio' },
  breakoutMinViewsPerDay: { min: 50, max: 1e9, int: true, label: 'Breakout minimum views per day' },
  rankMoveThreshold: { min: 1, max: 100, int: true, label: 'Rank move threshold' },
};

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const short = (s, max = 40) => clip(String(s), max);

/** Apply a partial settings object onto `current`, rejecting unknown keys, wrong types and out-of-range values. */
export function validateSettingsPatch(patch, current = defaultSettings()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('Settings must be a JSON object.');
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'types' || key === 'delivery') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`"${key}" must be an object of true/false values.`);
      for (const [k, v] of Object.entries(value)) {
        if (!Object.hasOwn(next[key], k)) throw badRequest(`Unknown ${key === 'types' ? 'alert type' : 'delivery channel'}: ${short(k)}`);
        if (typeof v !== 'boolean') throw badRequest(`${key}.${short(k)} must be true or false.`);
        next[key][k] = v;
      }
    } else if (Object.hasOwn(LIMITS, key)) {
      const lim = LIMITS[key];
      const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof num !== 'number' || !Number.isFinite(num)) throw badRequest(`${lim.label} must be a number.`);
      if (lim.int && !Number.isInteger(num)) throw badRequest(`${lim.label} must be a whole number.`);
      if (num < lim.min || num > lim.max) throw badRequest(`${lim.label} must be between ${lim.min} and ${lim.max}.`);
      next[key] = num;
    } else {
      throw badRequest(`Unknown setting: ${short(key)}`);
    }
  }
  return next;
}

/** Stored settings merged onto the defaults; invalid stored values (e.g. a hand-edited file) are ignored. */
export function normalizeSettings(stored) {
  let s = defaultSettings();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return s;
  for (const [k, v] of Object.entries(stored)) {
    try { s = validateSettingsPatch({ [k]: v }, s); } catch { /* keep the default */ }
  }
  return s;
}

// ---------- rules ----------

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const fmt = (x) => (Number.isFinite(x) ? compact.format(x) : '?');
const full = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '?');
const quote = (s) => `“${clip(String(s ?? '').trim() || 'Untitled', TITLE_MAX)}”`;
const videoUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const channelUrl = (id) => `https://www.youtube.com/channel/${encodeURIComponent(id)}`;
const searchUrl = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

/** Highest milestone with prev < m <= cur, or null (also null when either count is hidden/unknown). */
export function milestoneCrossed(prev, cur) {
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || cur <= prev) return null;
  let hit = null;
  for (const m of MILESTONES) if (prev < m && m <= cur) hit = m;
  return hit;
}

/**
 * Alert candidates from a tracker 'snapshot' event: { channel, snapshots (oldest -> newest), report }.
 * The first snapshot of a channel never alerts: there is nothing to compare its back catalogue with.
 */
export function snapshotAlerts({ channel, snapshots, report } = {}, settings = defaultSettings()) {
  const out = [];
  if (!Array.isArray(snapshots) || snapshots.length < 2) return out;
  const prev = snapshots.at(-2);
  const latest = snapshots.at(-1);
  const channelId = channel?.id || '';
  const who = clip(channel?.title || channelId || 'A tracked channel', TITLE_MAX);

  // (a) New uploads: in the latest snapshot, not in the previous one, and published after it was taken
  // (videos that merely scrolled into the "latest 30" window are older and are skipped).
  const before = new Set((prev.videos || []).map((v) => v.id));
  const allFresh = (latest.videos || [])
    .filter((v) => v?.id && !before.has(v.id) && Date.parse(v.publishedAt) > prev.t)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  for (const v of allFresh.slice(0, MAX_UPLOADS_PER_SNAPSHOT)) {
    out.push({
      type: 'upload',
      title: `New ${v.isShort ? 'Short' : 'video'} from ${who}`,
      message: `${quote(v.title)}${Number.isFinite(v.views) ? ` · ${fmt(v.views)} views when checked` : ''}`,
      url: videoUrl(v.id), videoId: v.id, channelId, channelTitle: who,
      dedupeKey: `upload:${v.id}`,
    });
  }

  // (b) Breakouts (see breakoutAlerts). A video that just got an upload alert waits for the next snapshot,
  // so one upload never sends two messages.
  const announced = settings.types?.upload === false ? new Set() : new Set(allFresh.map((v) => v.id));
  for (const b of breakoutAlerts(snapshots, report, settings)) {
    if (!announced.has(b.videoId)) out.push({ ...b, title: `Breakout video on ${who}`, channelId, channelTitle: who });
  }

  // (c) Subscriber milestone crossed between the two snapshots.
  const m = milestoneCrossed(prev.subs, latest.subs);
  if (m && channelId) {
    out.push({
      type: 'milestone',
      title: `${who} passed ${fmt(m)} subscribers`,
      message: `Subscribers went from ${full(prev.subs)} to ${full(latest.subs)} between snapshots.`,
      url: channelUrl(channelId), channelId, channelTitle: who,
      dedupeKey: `milestone:${channelId}:${m}`,
    });
  }
  return out;
}

/** Newest snapshot at least BREAKOUT_MIN_SPAN_MS older than the latest one (the tracker's trending baseline), or null. */
function trendBaseline(snapshots) {
  const latest = snapshots.at(-1);
  for (let i = snapshots.length - 2; i >= 0; i--) if (latest.t - snapshots[i].t >= BREAKOUT_MIN_SPAN_MS) return snapshots[i];
  return null;
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const spanText = (ms) => (ms < 2 * DAY ? plural(Math.round(ms / HOUR), 'hour') : plural(Math.round(ms / DAY), 'day'));
const ageText = (ms) => (ms < HOUR ? 'within an hour' : `after ${spanText(ms)}`);

/**
 * Breakout candidates (without channel fields). Two heuristics, because a video's first days are always its fastest:
 *  - videos at least YOUNG_VIDEO_MS old: views gained per day since a snapshot >= 12h earlier (the tracker's
 *    "trending" list) vs the channel's typical gain per day;
 *  - younger videos: total views so far vs the median views of the channel's established videos of the same
 *    format (Short or regular). An ordinary upload rarely gets there within its first week, so mostly outliers do.
 * Nothing is reported until the channel has >= 12h of snapshots (a forced refresh right after adding it would
 * extrapolate a few minutes of noise).
 */
export function breakoutAlerts(snapshots, report, settings = defaultSettings()) {
  const out = [];
  if (!Array.isArray(snapshots) || snapshots.length < 2) return out;
  const latest = snapshots.at(-1);
  const base = trendBaseline(snapshots);
  if (!base) return out;
  const age = (v) => latest.t - Date.parse(v.publishedAt); // NaN for a missing date: fails every check below
  const push = (v, message) => out.push({
    type: 'breakout', message, url: videoUrl(v.id), videoId: v.id,
    dedupeKey: `breakout:${v.id}`, cooldownMs: BREAKOUT_COOLDOWN_MS,
  });

  // Established videos. "isNew" entries are videos missing from the baseline snapshot: their figure is
  // views since publication, not a daily gain, so it is not comparable.
  for (const v of report?.trending || []) {
    if (!v?.id || v.isNew || !(age(v) >= YOUNG_VIDEO_MS)) continue;
    if (!(v.ratio >= settings.breakoutRatio && v.gainPerDay >= settings.breakoutMinViewsPerDay)) continue;
    const typical = v.typicalGainPerDay;
    const vs = typical >= 1 ? `${v.ratio.toFixed(1)}× the channel's typical ${fmt(typical)}/day` : "the channel's typical video gains under 1 view/day";
    push(v, `${quote(v.title)} gained ~${fmt(v.gainPerDay)} views/day over the last ${spanText(latest.t - base.t)} (${vs}).`);
  }

  // Young videos vs established videos of the same format.
  const videos = (latest.videos || []).filter((v) => v?.id && Number.isFinite(v.views));
  const peers = (isShort) => videos.filter((p) => !!p.isShort === isShort && age(p) >= YOUNG_VIDEO_MS).map((p) => p.views);
  const typical = { true: peers(true), false: peers(false) };
  for (const v of videos) {
    const a = age(v);
    if (!(a >= 0 && a < YOUNG_VIDEO_MS)) continue;
    const list = typical[!!v.isShort];
    const med = median(list);
    if (list.length < MIN_PEER_VIDEOS || !(med > 0)) continue;
    const ratio = v.views / med;
    const perDay = v.views / Math.max(a / DAY, 1 / 24);
    if (!(ratio >= settings.breakoutRatio && perDay >= settings.breakoutMinViewsPerDay)) continue;
    const kind = v.isShort ? 'Short' : 'video';
    push(v, `${quote(v.title)} already has ${fmt(v.views)} views ${ageText(a)}, ${ratio.toFixed(1)}× the channel's typical ${kind}`
      + ` (median ${fmt(med)} views across ${list.length} ${kind}s at least a week old).`);
  }
  return out;
}

const position = (p) => (Number.isInteger(p) && p > 0 ? p : null);
const inTop = (p, n) => p !== null && p <= n;

/**
 * Alert candidate from a 'ranks' event, or null.
 * { itemId, keyword, region, channelId, channelTitle, previous: { position|null, t|null }, current: { position|null, videoId, title, t, resultCount } }
 * src/ranks.js emits it only for conclusive checks (a "not found" on a short result page is not one), and
 * `previous` is the last conclusive check, so position null here really means "not in the top 50".
 */
export function rankAlert(e, settings = defaultSettings()) {
  if (!e?.current || !e.keyword) return null;
  if (e.previous?.position == null && e.previous?.t == null) return null; // first check: nothing to compare with
  const p = position(e.previous?.position);
  const c = position(e.current.position);
  let headline;
  if (inTop(c, 10) && !inTop(p, 10)) headline = 'Entered the top 10';
  else if (inTop(c, 50) && !inTop(p, 50)) headline = 'Entered the top 50';
  else if (inTop(p, 50) && !inTop(c, 50)) headline = 'Dropped out of the top 50';
  else if (p !== null && c !== null && Math.abs(p - c) >= settings.rankMoveThreshold) headline = c < p ? `Up ${p - c} places` : `Down ${c - p} places`;
  if (!headline) return null;

  const keyword = clip(String(e.keyword), TITLE_MAX);
  const who = clip(e.channelTitle || 'Your tracked channel', TITLE_MAX);
  const region = typeof e.region === 'string' && e.region ? ` (${e.region})` : '';
  const now = c !== null ? `is now #${c}` : 'is no longer in the checked results';
  const was = p !== null ? `was #${p}` : 'was not in the checked results';
  const videoId = e.current.videoId || null;
  return {
    type: 'rank',
    title: `${headline} for ${quote(keyword)}`,
    message: `${who} ${now} in YouTube search${region} (${was})${c !== null && e.current.title ? ` with ${quote(e.current.title)}` : ''}.`,
    url: videoId ? videoUrl(videoId) : searchUrl(keyword),
    videoId, channelId: e.channelId || '', channelTitle: who, keyword,
    dedupeKey: `rank:${e.itemId || `${keyword}|${e.region || ''}|${e.channelId || ''}`}:${e.current.t ?? ''}`,
  };
}

// ---------- delivery ----------

/** Shorten to at most `max` UTF-16 units (safe for limits counted in characters or code points). */
export function clip(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // don't split a surrogate pair (emoji)
  return `${cut}…`;
}

/** 'discord' | 'slack' | 'generic' for a webhook URL (null if it is not a URL). */
export function webhookKind(input) {
  let u;
  try { u = input instanceof URL ? input : new URL(input); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (/^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(host) && /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname)) return 'discord';
  if (/^hooks\.slack(?:-gov)?\.com$/.test(host)) return 'slack';
  return 'generic';
}

/** Public delivery status. Never contains tokens, chat ids or webhook URLs, only booleans, kind and host. */
export function deliveryConfig(env = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  const telegram = { configured: false };
  if (token || chatId) {
    const missing = [!token && 'TELEGRAM_BOT_TOKEN', !chatId && 'TELEGRAM_CHAT_ID'].filter(Boolean);
    if (missing.length) telegram.error = `Also set ${missing.join(' and ')}.`;
    else if (!/^\d+:[\w-]+$/.test(token)) telegram.error = 'TELEGRAM_BOT_TOKEN does not look like a bot token (digits, a colon, then letters and digits).';
    else if (/\s/.test(chatId)) telegram.error = 'TELEGRAM_CHAT_ID must not contain spaces.';
    else telegram.configured = true;
  }
  const webhook = { configured: false };
  const raw = String(env.ALERT_WEBHOOK_URL || '').trim();
  if (raw) {
    let u = null;
    try { u = new URL(raw); } catch { /* invalid */ }
    if (u && (u.protocol === 'https:' || u.protocol === 'http:')) Object.assign(webhook, { configured: true, kind: webhookKind(u), host: u.hostname });
    else webhook.error = 'ALERT_WEBHOOK_URL is not a valid http(s) URL.';
  }
  return { telegram, webhook };
}

/** Plain-text body shared by every channel (no parse_mode / markup, so nothing needs escaping). */
export function alertText(alert, { demo = alert?.demo } = {}) {
  const lines = [alert.title, alert.message, alert.url].filter(Boolean);
  return `${demo ? '[Demo data] ' : ''}${lines.join('\n')}`;
}

export function telegramRequest(alert, { token, chatId }) {
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    // chat_id is "Integer or String"; numeric ids (negative for groups) are sent as numbers
    body: { chat_id: /^-?\d{1,16}$/.test(chatId) ? Number(chatId) : chatId, text: clip(alertText(alert), TELEGRAM_MAX) },
  };
}

// Slack treats &, < and > as control characters: https://docs.slack.dev/messaging/formatting-message-text/
const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Discord renders a subset of markdown in `content` (https://docs.discord.com/developers/reference#message-formatting),
// and titles come from other creators. Backslash-escape markdown syntax so a title like "[x](https://…) **y**"
// shows as typed instead of as a masked link or bold text; `<` also covers <@id> / <#id> / <t:…> tags.
export function discordEscape(s) {
  return String(s ?? '')
    .replace(/[\\*_~`|<>[\]]/g, '\\$&') // emphasis, code, spoilers, quotes, tags, masked links ("[x](y)")
    .replace(/^(\s*-?)#/gm, '$1\\#') // headings and "-#" subtext (only at the start of a line)
    .replace(/^(\s*)([-+])(?=\s)/gm, '$1\\$2') // list bullets ("*" is escaped above)
    .replace(/^(\s*\d+)\.(?=\s)/gm, '$1\\.'); // numbered lists
}

/** clip() that never leaves a dangling escape backslash right before the ellipsis. */
const clipEscaped = (s, max) => clip(s, max).replace(/(^|[^\\])((?:\\\\)*)\\…$/, '$1$2…');

export function webhookBody(alert, kind) {
  if (kind === 'discord') {
    const url = /^https:\/\/\S+$/.test(alert.url || '') ? alert.url : '';
    const head = [alert.title, alert.message].filter(Boolean).map(discordEscape).join('\n');
    const room = DISCORD_MAX - (alert.demo ? '\\[Demo data\\] '.length : 0) - (url ? url.length + 1 : 0);
    return {
      content: `${alert.demo ? '\\[Demo data\\] ' : ''}${clipEscaped(head, room)}${url ? `\n${url}` : ''}`,
      allowed_mentions: { parse: [] }, // stops titles like "@everyone" from pinging the server
    };
  }
  if (kind === 'slack') {
    const lines = [
      slackEscape(`${alert.demo ? '[Demo data] ' : ''}${clip(alert.title, 500)}`),
      alert.message && slackEscape(clip(alert.message, 2000)),
      /^https:\/\/[^\s<>|]+$/.test(alert.url || '') && `<${alert.url}>`,
    ];
    return { text: lines.filter(Boolean).join('\n') };
  }
  const { id, type, title, message, url, channelTitle, createdAt, demo = false } = alert;
  return { text: clip(alertText(alert), TEXT_CAP), alert: { id, type, title, message, url, channelTitle, createdAt, demo } };
}

function describeError(e, timeoutMs) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `No response within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`;
  const code = e?.cause?.code ? ` (${e.cause.code})` : '';
  return `${e?.message || 'Request failed'}${code}`;
}

// ---------- manager ----------

// Pacing between two messages to the same destination. Our own conservative choice, based on each platform's guidance:
//   Telegram: about 1 message/s in a single chat, at most 20/min in a group  https://core.telegram.org/bots/faq
//   Slack incoming webhooks: 1 message/s per channel                         https://docs.slack.dev/apis/web-api/rate-limits
//   Discord publishes no fixed webhook rate; it answers 429 with `retry_after` (seconds) and X-RateLimit-* headers
//   https://docs.discord.com/developers/topics/rate-limits
export const PACE_MS = { telegramPrivate: 1100, telegramGroup: 3100, webhook: 1100 };
// A 429 asking us to wait longer than this is recorded as a failure instead of holding the queue.
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const DEFAULT_RETRY_MS = 5000; // a 429 without any retry hint

/** How long a 429 response asks us to wait, in ms: Telegram `parameters.retry_after`, Discord `retry_after`, or Retry-After. */
export function retryAfterMs(res, data) {
  const fromBody = Number(data?.parameters?.retry_after ?? data?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody * 1000);
  const header = String(res?.headers?.get?.('retry-after') ?? '').trim();
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return DEFAULT_RETRY_MS;
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitText = (ms) => (ms < 90_000 ? `${Math.ceil(ms / 1000)}s` : `${Math.ceil(ms / 60_000)} min`);

export class AlertManager {
  #secrets;
  #queue = Promise.resolve(); // event processing (rules, dedupe, feed): serialized, never waits on the network
  #lanes = new Map(); // delivery target -> { tail: Promise, readyAt: ms }: one paced queue per destination
  #lastTestAt = 0;

  constructor({ store, env = {}, demo = false, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = sleepReal, log = () => {}, timeoutMs = 10_000 }) {
    this.store = store;
    this.demo = demo;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.config = deliveryConfig(env);
    this.#secrets = {
      token: String(env.TELEGRAM_BOT_TOKEN || '').trim(),
      chatId: String(env.TELEGRAM_CHAT_ID || '').trim(),
      webhookUrl: String(env.ALERT_WEBHOOK_URL || '').trim(),
    };
    // Deliveries still queued when the server stopped will never be sent: say so instead of "sending…" forever.
    this.#enqueue(() => this.#failInterrupted()).catch((e) => this.log(`Alerts: could not check unsent alerts: ${e.message}`));
  }

  deliveryStatus() { return structuredClone(this.config); }

  async getSettings() { return normalizeSettings(await this.store.read('alerts-settings', null)); }

  saveSettings(patch) {
    return this.store.update('alerts-settings', null, (cur) => validateSettingsPatch(patch, normalizeSettings(cur)));
  }

  async list({ limit = 50 } = {}) {
    const all = await this.store.read('alerts', []);
    return { alerts: all.slice(0, limit), unread: all.filter((a) => !a.read).length, total: all.length };
  }

  async markRead({ ids = [], all = false } = {}) {
    const wanted = new Set(ids);
    const list = await this.store.update('alerts', [], (cur) => cur.map((a) => (!a.read && (all || wanted.has(a.id)) ? { ...a, read: true } : a)));
    return { ok: true, unread: list.filter((a) => !a.read).length };
  }

  async clear() {
    await this.store.update('alerts', [], () => []); // dedupe history ('alerts-seen') is kept on purpose
    return { ok: true };
  }

  /**
   * Event handlers. Processing is serialized so concurrent events can't race on the stores. They resolve once
   * the alerts are in the feed; external delivery continues in the background (see idle()).
   */
  handleSnapshot(payload) {
    return this.#enqueue(async () => {
      const settings = await this.getSettings();
      return this.#emit(snapshotAlerts(payload, settings), settings);
    });
  }

  handleRanks(payload) {
    return this.#enqueue(async () => {
      const settings = await this.getSettings();
      const a = rankAlert(payload, settings);
      return this.#emit(a ? [a] : [], settings);
    });
  }

  /** Resolves when queued events and deliveries have all finished (tests, graceful shutdown). */
  async idle() {
    for (;;) {
      const pending = [this.#queue, ...[...this.#lanes.values()].map((l) => l.tail)];
      await Promise.all(pending);
      const now = [this.#queue, ...[...this.#lanes.values()].map((l) => l.tail)];
      if (now.length === pending.length && now.every((p, i) => p === pending[i])) return;
    }
  }

  /**
   * Send a test message to every configured channel (ignores the on/off toggles, so setup can be checked).
   * Sent right away rather than behind queued alerts, so the person gets an answer; a 429 is reported, not waited out.
   */
  async sendTest() {
    const now = this.now();
    if (now - this.#lastTestAt < TEST_COOLDOWN_MS) throw Object.assign(new Error('Wait a few seconds before sending another test.'), { status: 429 });
    this.#lastTestAt = now;
    const alert = {
      id: 'test', type: 'test', title: 'TubeScout test alert',
      message: 'Alert delivery works. Real alerts are sent when tracked channels or ranked keywords change.',
      url: '', channelTitle: '', createdAt: new Date(now).toISOString(),
    };
    const results = await Promise.all(this.#targets(null).map(async (t) => {
      const r = await this.#send(t, alert, { retry: false });
      const lane = this.#lane(t);
      lane.readyAt = Math.max(lane.readyAt, this.now() + this.#pace(t)); // queued alerts keep their distance
      return r;
    }));
    return { results };
  }

  #enqueue(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {}); // callers handle their own errors; keep the queue alive
    return run;
  }

  /** Dedupe and store candidates, then queue their delivery. Returns the alerts that were created. */
  async #emit(candidates, settings) {
    const enabled = candidates.filter((c) => settings.types[c.type]);
    if (!enabled.length) return [];
    const now = this.now();
    let fresh = [];
    await this.store.update('alerts-seen', {}, (seen) => {
      const next = pruneSeen(seen, now);
      const batch = new Set();
      fresh = enabled.filter((c) => {
        if (batch.has(c.dedupeKey)) return false;
        const at = next[c.dedupeKey];
        if (at !== undefined && !(c.cooldownMs && now - at >= c.cooldownMs)) return false;
        batch.add(c.dedupeKey);
        return true;
      });
      for (const c of fresh) next[c.dedupeKey] = now; // marked before delivery: at most once, even if we crash
      return next;
    });
    if (!fresh.length) return [];

    const targets = this.#targets(settings);
    const createdAt = new Date(now).toISOString();
    const alerts = fresh.map(({ cooldownMs, ...c }) => ({
      id: randomUUID(), ...c, createdAt, read: false, ...(this.demo ? { demo: true } : {}),
      deliveries: targets.map((t) => ({ channel: this.#channelName(t), pending: true })),
    }));
    await this.store.update('alerts', [], (list) => [...alerts, ...(Array.isArray(list) ? list : [])].slice(0, MAX_ALERTS));
    for (const t of targets) for (const a of alerts) this.#schedule(t, a);
    return alerts;
  }

  /** Queue one message on its destination's lane; lanes run independently, so a dead webhook can't hold up Telegram. */
  #schedule(target, alert) {
    const lane = this.#lane(target);
    lane.tail = lane.tail
      .then(() => this.#sendPaced(target, alert))
      .then((result) => this.#record(alert.id, result))
      .catch((e) => this.log(`Alerts: delivery bookkeeping failed: ${e.message}`));
  }

  async #sendPaced(target, alert) {
    const lane = this.#lane(target);
    const wait = lane.readyAt - this.now();
    if (wait > MAX_RATE_LIMIT_WAIT_MS) {
      return { channel: this.#channelName(target), ok: false, error: `Not sent: rate limited, the service asked to wait ${waitText(wait)}` };
    }
    if (wait > 0) await this.sleep(wait);
    const result = await this.#send(target, alert);
    lane.readyAt = Math.max(lane.readyAt, this.now() + this.#pace(target));
    return result;
  }

  /** Replace the alert's pending entry for this channel with the result (no-op if the feed was cleared meanwhile). */
  async #record(alertId, result) {
    await this.store.update('alerts', [], (list) => (Array.isArray(list) ? list : []).map((a) => (a.id !== alertId ? a : {
      ...a, deliveries: (a.deliveries || []).map((d) => (d.pending && d.channel === result.channel ? result : d)),
    })));
    if (!result.ok) this.log(`Alert delivery to ${result.channel} failed: ${result.error}`);
  }

  async #failInterrupted() {
    const list = await this.store.read('alerts', []);
    if (!Array.isArray(list) || !list.some((a) => a?.deliveries?.some?.((d) => d?.pending))) return;
    const error = 'Not sent: the server stopped before this alert was delivered';
    await this.store.update('alerts', [], (cur) => (Array.isArray(cur) ? cur : []).map((a) => (!a?.deliveries?.some?.((d) => d?.pending) ? a : {
      ...a, deliveries: a.deliveries.map((d) => (d?.pending ? { channel: d.channel, ok: false, error } : d)),
    })));
  }

  #lane(target) {
    if (!this.#lanes.has(target)) this.#lanes.set(target, { tail: Promise.resolve(), readyAt: 0 });
    return this.#lanes.get(target);
  }

  #pace(target) {
    if (target !== 'telegram') return PACE_MS.webhook;
    // Private chats have positive ids; groups, supergroups and channels are negative ids or @usernames.
    return /^\d+$/.test(this.#secrets.chatId) ? PACE_MS.telegramPrivate : PACE_MS.telegramGroup;
  }

  #channelName(target) {
    if (target === 'telegram') return 'telegram';
    const kind = this.config.webhook.kind;
    return kind === 'generic' ? 'webhook' : kind;
  }

  /** Configured channels, filtered by the settings toggles unless settings is null. */
  #targets(settings) {
    const t = [];
    if (this.config.telegram.configured && (!settings || settings.delivery.telegram)) t.push('telegram');
    if (this.config.webhook.configured && (!settings || settings.delivery.webhook)) t.push('webhook');
    return t;
  }

  /** One message. On a 429 it waits as asked (up to MAX_RATE_LIMIT_WAIT_MS) and retries once when `retry` is set. */
  async #send(target, alert, { retry = true } = {}) {
    const channel = this.#channelName(target);
    const name = target === 'telegram' ? 'Telegram' : channel[0].toUpperCase() + channel.slice(1);
    try {
      for (let attempt = 0; ; attempt++) {
        let res;
        let data = null;
        let text = '';
        if (target === 'telegram') {
          const { url, body } = telegramRequest(alert, this.#secrets);
          res = await this.#post(url, body);
          data = await res.json().catch(() => null);
        } else {
          res = await this.#post(this.#secrets.webhookUrl, webhookBody(alert, this.config.webhook.kind));
          text = await res.text().catch(() => '');
          if (res.status === 429) try { data = JSON.parse(text); } catch { /* not JSON */ }
        }
        if (res.status === 429) {
          const wait = retryAfterMs(res, data);
          const lane = this.#lane(target);
          lane.readyAt = Math.max(lane.readyAt, this.now() + wait); // later messages on this lane wait too
          if (retry && attempt === 0 && wait <= MAX_RATE_LIMIT_WAIT_MS) {
            await this.sleep(wait);
            continue;
          }
          throw new Error(`Rate limited by ${name} (HTTP 429): try again in ${waitText(wait)}`);
        }
        if (target === 'telegram' && (!res.ok || !data?.ok)) throw new Error(`Telegram said: ${clip(data?.description || `HTTP ${res.status}`, 200)}`);
        if (target !== 'telegram' && !res.ok) throw new Error(`HTTP ${res.status}${text.trim() ? `: ${clip(text.trim(), 200)}` : ''}`);
        // Discord also reports an exhausted bucket on successful responses: wait for it before the next message.
        if (res.headers?.get?.('x-ratelimit-remaining') === '0') {
          const reset = Number(res.headers.get('x-ratelimit-reset-after'));
          if (Number.isFinite(reset) && reset > 0) {
            const lane = this.#lane(target);
            lane.readyAt = Math.max(lane.readyAt, this.now() + Math.ceil(reset * 1000));
          }
        }
        return { channel, ok: true };
      }
    } catch (e) {
      return { channel, ok: false, error: this.#redact(describeError(e, this.timeoutMs)) };
    }
  }

  #post(url, body) {
    return this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'manual', // a redirect is reported as an error instead of silently re-posting elsewhere
    });
  }

  /** Error text can come from remote servers or fetch internals: strip anything secret before storing it. */
  #redact(msg) {
    let out = String(msg);
    for (const s of [this.#secrets.token, this.#secrets.webhookUrl, this.#secrets.chatId]) {
      if (s && s.length >= 4) out = out.split(s).join('[redacted]');
    }
    return out;
  }
}

function pruneSeen(seen, now) {
  const entries = Object.entries(seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {})
    .filter(([, t]) => Number.isFinite(t) && now - t < SEEN_MAX_AGE_MS);
  if (entries.length > SEEN_MAX_KEYS) entries.sort((a, b) => b[1] - a[1]).length = SEEN_MAX_KEYS;
  return Object.fromEntries(entries);
}
