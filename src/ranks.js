// Daily YouTube search rank tracking: where does a channel's first video rank for a keyword?
//
// A check runs one YouTube search (search.list, top 50 results in relevance order) and records every
// position held by the tracked channel's videos. Checks are capped per rolling 24 hours because search
// requests are the scarcest part of the YouTube API quota.
//
// Store layout (JsonStore):
//   'ranks'        [{ id, keyword, region|null, channelId, channelTitle, addedAt }]   (max MAX_ITEMS)
//   'rank-<id>'    [{ t, position|null, positions, videoId|null, title|null, resultCount, top3 }]  (last MAX_HISTORY)
//   'ranks-quota'  [timestamps of checks in the last 24h]
import { createHash } from 'node:crypto';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const MAX_ITEMS = 30;
export const MAX_HISTORY = 400; // ~13 months of daily checks
export const SEARCH_DEPTH = 50; // search.list maxResults upper bound
export const DUE_AFTER_MS = 20 * HOUR; // "daily", with slack so the hourly job doesn't drift a day
export const RECHECK_MIN_MS = 15 * MINUTE; // the YouTube client caches identical searches this long
export const WEEK_LOOKBACK_MS = 6.5 * DAY; // "change vs ~7 days ago" compares with a check at least this old
export const KEYWORD_MAX = 100;
export const DEFAULT_MAX_CHECKS_PER_DAY = 20;

const LIST_KEY = 'ranks';
const QUOTA_KEY = 'ranks-quota';
const historyKey = (id) => `rank-${id}`;
const ID_RE = /^[a-f0-9]{12}$/;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Trim and collapse whitespace; returns '' for non-strings. */
export function normalizeKeyword(k) {
  return typeof k === 'string' ? k.replace(/\s+/g, ' ').trim() : '';
}

/** Stable short id for (keyword, region, channel); the keyword is compared case-insensitively. */
export function itemId(keyword, region, channelId) {
  return createHash('sha256')
    .update(`${normalizeKeyword(keyword).toLowerCase()}\n${region || ''}\n${channelId}`)
    .digest('hex')
    .slice(0, 12);
}

export const isItemId = (id) => typeof id === 'string' && ID_RE.test(id);

/**
 * Where does `channelId` appear in search results (raw video items, already in rank order)?
 * Returns 1-based positions of all the channel's videos; `position` is the best (first) one.
 */
export function findPositions(results, channelId) {
  const positions = [];
  (results || []).forEach((v, i) => { if (v?.snippet?.channelId === channelId) positions.push(i + 1); });
  const first = positions.length ? results[positions[0] - 1] : null;
  return {
    position: positions[0] ?? null,
    positions,
    videoId: first?.id ?? null,
    title: first?.snippet?.title ?? null,
  };
}

/** Who holds the top 3 spots (for context: "who outranks me?"). */
export function topResults(results, n = 3) {
  return (results || []).slice(0, n).map((v) => ({
    channelTitle: v?.snippet?.channelTitle || '',
    title: v?.snippet?.title || '',
  }));
}

/**
 * Compare two checks. A LOWER position is better, so `places` = from - to: positive means the video
 * moved up. `dir`: 'up' | 'down' | 'same' | 'entered' (now in the top 50) | 'dropped' (fell out of it).
 */
export function rankChange(prev, cur) {
  if (!prev || !cur) return null;
  const from = prev.position ?? null;
  const to = cur.position ?? null;
  let places = null;
  let dir;
  if (from === null && to === null) dir = 'same';
  else if (from === null) dir = 'entered';
  else if (to === null) dir = 'dropped';
  else {
    places = from - to;
    dir = places > 0 ? 'up' : places < 0 ? 'down' : 'same';
  }
  return { from, to, since: prev.t, places, dir };
}

/** Per-item report for the UI (pure; `history` is oldest -> newest). */
export function rankReport(item, history, now = Date.now()) {
  const hist = Array.isArray(history) ? history : [];
  const latest = hist.at(-1) || null;
  const previous = hist.length > 1 ? hist.at(-2) : null;
  // Nearest check that is at least ~6.5 days older than the latest one.
  let weekAgo = null;
  if (latest) {
    for (let i = hist.length - 2; i >= 0; i--) {
      if (hist[i].t <= latest.t - WEEK_LOOKBACK_MS) { weekAgo = hist[i]; break; }
    }
  }
  let best = null;
  for (const h of hist) {
    if (h.position !== null && h.position !== undefined && (!best || h.position < best.position)) best = { position: h.position, t: h.t };
  }
  return {
    id: item.id,
    keyword: item.keyword,
    region: item.region ?? null,
    channelId: item.channelId,
    channelTitle: item.channelTitle,
    addedAt: item.addedAt,
    checks: hist.length,
    lastChecked: latest?.t ?? null,
    due: !latest || now - latest.t >= DUE_AFTER_MS,
    position: latest ? latest.position ?? null : null,
    positions: latest?.positions || [],
    videoId: latest?.videoId ?? null,
    title: latest?.title ?? null,
    resultCount: latest?.resultCount ?? null,
    top3: latest?.top3 || [],
    change: rankChange(previous, latest),
    change7d: rankChange(weekAgo, latest),
    best,
    firstChecked: hist[0]?.t ?? null,
    daysTracked: hist.length ? Math.max(0, Math.floor((now - hist[0].t) / DAY)) : 0,
    series: hist.map((h) => ({ t: h.t, position: h.position ?? null })),
  };
}

/** Checks inside the rolling 24h window ending at `now`. */
export const checksInWindow = (log, now) => (Array.isArray(log) ? log : []).filter((t) => Number.isFinite(t) && t > now - DAY && t <= now);

const inWords = (ms) => {
  const m = Math.max(1, Math.ceil(ms / MINUTE));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
};

export class RankTracker {
  /**
   * @param {object} o
   * @param {object} o.client  YouTubeClient or DemoClient
   * @param {object} o.store   JsonStore
   * @param {import('node:events').EventEmitter} [o.events]  receives 'ranks' after every check
   * @param {number} [o.maxChecksPerDay]  rolling-24h cap on checks (manual + automatic)
   */
  constructor({ client, store, events = null, maxChecksPerDay = DEFAULT_MAX_CHECKS_PER_DAY, now = () => Date.now(), log = () => {} }) {
    this.client = client;
    this.store = store;
    this.events = events;
    this.maxChecksPerDay = maxChecksPerDay;
    this.now = now;
    this.log = log;
    this.running = null;
    this.timers = [];
  }

  list() { return this.store.read(LIST_KEY, []); }
  history(id) { return this.store.read(historyKey(id), []); }
  async get(id) { return (await this.list()).find((i) => i.id === id) || null; }

  async quota() {
    const now = this.now();
    const recent = checksInWindow(await this.store.read(QUOTA_KEY, []), now);
    const full = recent.length >= this.maxChecksPerDay;
    return {
      checksLast24h: recent.length,
      maxChecksPerDay: this.maxChecksPerDay,
      // When the oldest check in the window expires (only meaningful when the cap is reached).
      nextSlotAt: full && recent.length ? Math.min(...recent) + DAY : null,
    };
  }

  /** Atomically claim one check from the rolling 24h budget, or throw 429. */
  async reserveCheck() {
    const now = this.now();
    const max = this.maxChecksPerDay;
    await this.store.update(QUOTA_KEY, [], (log) => {
      const recent = checksInWindow(log, now);
      if (recent.length >= max) {
        if (max <= 0) throw httpError(429, 'Rank checks are disabled (RANK_MAX_CHECKS_PER_DAY=0).');
        const wait = Math.min(...recent) + DAY - now;
        throw httpError(429, `Daily rank-check limit reached: ${recent.length} of ${max} checks used in the last 24 hours (RANK_MAX_CHECKS_PER_DAY). The next check becomes available in about ${inWords(wait)}.`);
      }
      return [...recent, now];
    });
  }

  async reports() {
    const now = this.now();
    const items = await this.list();
    return Promise.all(items.map(async (item) => rankReport(item, await this.history(item.id), now)));
  }

  async report(id) {
    const item = await this.get(id);
    return item ? rankReport(item, await this.history(id), this.now()) : null;
  }

  /**
   * Start tracking. `channel` is already resolved by the caller: { id, title }.
   * Returns the new item; throws 409 for a duplicate and 400 when the list is full.
   */
  async add({ keyword, region = null, channel }) {
    const kw = normalizeKeyword(keyword);
    const id = itemId(kw, region, channel.id);
    const item = {
      id, keyword: kw, region: region || null, channelId: channel.id, channelTitle: channel.title || channel.id,
      addedAt: new Date(this.now()).toISOString(),
    };
    await this.store.update(LIST_KEY, [], (list) => {
      if (list.some((i) => i.id === id)) {
        throw httpError(409, `Already tracking "${kw}" for ${item.channelTitle}${region ? ` in ${region}` : ''}.`);
      }
      if (list.length >= MAX_ITEMS) throw httpError(400, `You can track up to ${MAX_ITEMS} keyword rankings. Remove one first.`);
      return [...list, item];
    });
    return item;
  }

  async remove(id) {
    let found = false;
    await this.store.update(LIST_KEY, [], (list) => {
      found = list.some((i) => i.id === id);
      return list.filter((i) => i.id !== id);
    });
    await this.store.remove(historyKey(id));
    return found;
  }

  /** Run one check for `item` (spends one search from the daily budget). Returns the history entry. */
  async check(item) {
    await this.reserveCheck();
    const results = await this.client.searchVideos(item.keyword, { max: SEARCH_DEPTH, regionCode: item.region || undefined });
    const entry = {
      t: this.now(),
      ...findPositions(results, item.channelId),
      resultCount: results.length,
      top3: topResults(results),
    };
    // The item may have been removed while the search was running; don't resurrect its history file.
    if (!(await this.get(item.id))) return null;
    let previous = null;
    await this.store.update(historyKey(item.id), [], (list) => {
      previous = list.at(-1) || null;
      return [...list, entry].slice(-MAX_HISTORY);
    });
    this.#emit(item, previous, entry);
    return entry;
  }

  #emit(item, previous, entry) {
    if (!this.events) return;
    const payload = {
      itemId: item.id,
      keyword: item.keyword,
      region: item.region ?? null,
      channelId: item.channelId,
      channelTitle: item.channelTitle,
      previous: { position: previous ? previous.position ?? null : null, t: previous ? previous.t : null },
      current: { position: entry.position, videoId: entry.videoId, title: entry.title, t: entry.t },
    };
    // A failing listener (e.g. an alert channel) must not fail the check itself.
    try { this.events.emit('ranks', payload); } catch (e) { this.log(`'ranks' listener failed: ${e.message}`); }
  }

  /**
   * Check every item whose last check is older than DUE_AFTER_MS (never-checked first, then oldest),
   * one at a time. Stops early when the daily budget or the YouTube quota runs out.
   * Concurrent calls share one run.
   */
  runDue() {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = this.now();
      const due = [];
      for (const item of await this.list()) {
        const last = (await this.history(item.id)).at(-1)?.t ?? null;
        if (last === null || now - last >= DUE_AFTER_MS) due.push({ item, last });
      }
      due.sort((a, b) => (a.last ?? -Infinity) - (b.last ?? -Infinity));
      const results = [];
      for (const { item } of due) {
        try {
          const entry = await this.check(item);
          if (entry) results.push({ id: item.id, position: entry.position });
        } catch (e) {
          results.push({ id: item.id, error: e.message, status: e.status || 500 });
          if (e.status === 429 || e.reason === 'quotaExceeded') break; // the rest would fail the same way
          this.log(`Rank check failed for "${item.keyword}": ${e.message}`);
        }
      }
      return { due: due.length, results };
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Hourly background job (timers are unref'd so they never keep the process alive). */
  start() {
    const run = () => this.runDue().catch((e) => this.log(`Rank checks failed: ${e.message}`));
    this.timers.push(setTimeout(run, 30_000).unref(), setInterval(run, HOUR).unref());
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }
}
