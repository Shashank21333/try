// Competitor and ranking alerts: rules that turn tracker snapshots and rank checks into alerts,
// an in-app feed (JSON store) and optional delivery to Telegram, Discord, Slack or any JSON webhook.
//
// Stores:  'alerts'          feed, newest first (max MAX_ALERTS)
//          'alerts-settings' user settings (see defaultSettings)
//          'alerts-seen'     { dedupeKey: firstSeenMs } so restarts and replays never resend
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
export const MAX_ALERTS = 500;
export const BREAKOUT_COOLDOWN_MS = 7 * DAY; // at most one breakout alert per video per 7 days
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
  const fresh = (latest.videos || [])
    .filter((v) => v?.id && !before.has(v.id) && Date.parse(v.publishedAt) > prev.t)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_UPLOADS_PER_SNAPSHOT);
  for (const v of fresh) {
    out.push({
      type: 'upload',
      title: `New ${v.isShort ? 'Short' : 'video'} from ${who}`,
      message: `${quote(v.title)}${Number.isFinite(v.views) ? ` · ${fmt(v.views)} views when checked` : ''}`,
      url: videoUrl(v.id), videoId: v.id, channelId, channelTitle: who,
      dedupeKey: `upload:${v.id}`,
    });
  }

  // (b) Breakouts: the tracker's "trending" list, filtered by the user's stricter thresholds.
  for (const v of report?.trending || []) {
    if (!v?.id || !(v.ratio >= settings.breakoutRatio && v.gainPerDay >= settings.breakoutMinViewsPerDay)) continue;
    out.push({
      type: 'breakout',
      title: `Breakout video on ${who}`,
      message: `${quote(v.title)} is getting ~${fmt(v.gainPerDay)} views/day ${v.isNew ? 'since it was published' : 'since the previous snapshot'}`
        + ` (${v.ratio.toFixed(1)}× the channel's typical ${fmt(v.typicalGainPerDay)}/day).`,
      url: videoUrl(v.id), videoId: v.id, channelId, channelTitle: who,
      dedupeKey: `breakout:${v.id}`,
      cooldownMs: BREAKOUT_COOLDOWN_MS,
    });
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

const position = (p) => (Number.isInteger(p) && p > 0 ? p : null);
const inTop = (p, n) => p !== null && p <= n;

/**
 * Alert candidate from a 'ranks' event, or null.
 * { itemId, keyword, region, channelId, channelTitle, previous: { position|null, t|null }, current: { position|null, videoId, title, t } }
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

export function webhookBody(alert, kind) {
  if (kind === 'discord') {
    // allowed_mentions.parse = [] stops titles like "@everyone" from pinging the server
    return { content: clip(alertText(alert), DISCORD_MAX), allowed_mentions: { parse: [] } };
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

export class AlertManager {
  #secrets;
  #queue = Promise.resolve();
  #lastTestAt = 0;

  constructor({ store, env = {}, demo = false, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, timeoutMs = 10_000 }) {
    this.store = store;
    this.demo = demo;
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.config = deliveryConfig(env);
    this.#secrets = {
      token: String(env.TELEGRAM_BOT_TOKEN || '').trim(),
      chatId: String(env.TELEGRAM_CHAT_ID || '').trim(),
      webhookUrl: String(env.ALERT_WEBHOOK_URL || '').trim(),
    };
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

  /** Event handlers. Processing is serialized so concurrent events can't race on the stores. */
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

  /** Send a test message to every configured channel (ignores the on/off toggles, so setup can be checked). */
  async sendTest() {
    const now = this.now();
    if (now - this.#lastTestAt < TEST_COOLDOWN_MS) throw Object.assign(new Error('Wait a few seconds before sending another test.'), { status: 429 });
    this.#lastTestAt = now;
    const alert = {
      id: 'test', type: 'test', title: 'TubeScout test alert',
      message: 'Alert delivery works. Real alerts are sent when tracked channels or ranked keywords change.',
      url: '', channelTitle: '', createdAt: new Date(now).toISOString(),
    };
    return { results: await this.#deliver(alert, this.#targets(null)) };
  }

  #enqueue(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {}); // callers handle their own errors; keep the queue alive
    return run;
  }

  /** Dedupe, store and deliver candidates. Returns the alerts that were created. */
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

    const createdAt = new Date(now).toISOString();
    const alerts = fresh.map(({ cooldownMs, ...c }) => ({
      id: randomUUID(), ...c, createdAt, read: false, ...(this.demo ? { demo: true } : {}), deliveries: [],
    }));
    await this.store.update('alerts', [], (list) => [...alerts, ...(Array.isArray(list) ? list : [])].slice(0, MAX_ALERTS));

    const targets = this.#targets(settings);
    if (!targets.length) return alerts;
    // One alert at a time (gentle on chat rate limits); its channels in parallel.
    for (const a of alerts) a.deliveries = await this.#deliver(a, targets);
    const byId = new Map(alerts.map((a) => [a.id, a.deliveries]));
    await this.store.update('alerts', [], (list) => list.map((a) => (byId.has(a.id) ? { ...a, deliveries: byId.get(a.id) } : a)));
    for (const a of alerts) for (const d of a.deliveries) if (!d.ok) this.log(`Alert delivery to ${d.channel} failed: ${d.error}`);
    return alerts;
  }

  /** Configured channels, filtered by the settings toggles unless settings is null. */
  #targets(settings) {
    const t = [];
    if (this.config.telegram.configured && (!settings || settings.delivery.telegram)) t.push('telegram');
    if (this.config.webhook.configured && (!settings || settings.delivery.webhook)) t.push('webhook');
    return t;
  }

  #deliver(alert, targets) {
    return Promise.all(targets.map((t) => this.#send(t, alert)));
  }

  async #send(target, alert) {
    const kind = this.config.webhook.kind;
    const channel = target === 'telegram' ? 'telegram' : (kind === 'generic' ? 'webhook' : kind);
    try {
      if (target === 'telegram') {
        const { url, body } = telegramRequest(alert, this.#secrets);
        const res = await this.#post(url, body);
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) throw new Error(`Telegram said: ${clip(data?.description || `HTTP ${res.status}`, 200)}`);
      } else {
        const res = await this.#post(this.#secrets.webhookUrl, webhookBody(alert, kind));
        const text = await res.text().catch(() => '');
        if (!res.ok) throw new Error(`HTTP ${res.status}${text.trim() ? `: ${clip(text.trim(), 200)}` : ''}`);
      }
      return { channel, ok: true };
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
