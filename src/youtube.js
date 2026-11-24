// Thin client for the YouTube Data API v3 with in-memory caching and quota tracking.
// Quota (YouTube Data API docs, granular quota since June 1, 2026):
//   channels.list, videos.list, playlistItems.list = 1 unit per call from the 10,000 units/day pool
//   search.list = its own "Search Queries" bucket: 1 per call, default 100 calls/day
//   https://developers.google.com/youtube/v3/determine_quota_cost

const API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeApiError extends Error {
  constructor(message, status = 500, reason = null) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** Understand the ways people paste a channel: URL, @handle, channel ID, or a name. */
export function parseChannelInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^(https?:\/\/)?((www|m)\.)?youtube\.com\//i.test(s)) {
    try {
      const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] === 'channel' && parts[1]) return { type: 'id', value: parts[1] };
      if (parts[0]?.startsWith('@')) return { type: 'handle', value: parts[0] };
      if (parts[0] === 'user' && parts[1]) return { type: 'username', value: parts[1] };
      if (parts[0] === 'c' && parts[1]) return { type: 'search', value: parts[1] };
      if (parts[0]) return { type: 'search', value: parts[0] };
    } catch { /* fall through */ }
  }
  if (/^UC[\w-]{22}$/.test(s)) return { type: 'id', value: s };
  if (s.startsWith('@')) return { type: 'handle', value: s };
  if (/^[\w.-]{3,30}$/.test(s)) return { type: 'handleOrSearch', value: s };
  return { type: 'search', value: s };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export class YouTubeClient {
  constructor(apiKey, { fetchImpl = globalThis.fetch, cacheTtlMs = 15 * 60_000 } = {}) {
    if (!apiKey) throw new Error('YouTubeClient requires an API key');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
    this.quotaUsed = 0; // units from the 10,000/day pool
    this.searchCalls = 0; // calls from the separate search.list bucket (default 100/day)
  }

  /** cost = units from the main pool; search.list calls are counted in their own bucket instead. */
  async request(endpoint, params, cost = 1) {
    const url = new URL(`${API_BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const cacheKey = url.toString();
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.body;

    url.searchParams.set('key', this.apiKey);
    const res = await this.fetch(url, { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body.error || {};
      const reason = err.errors?.[0]?.reason || null;
      const msg = reason === 'quotaExceeded'
        ? 'YouTube API daily quota exceeded (search is limited to about 100 calls a day by default; other calls share 10,000 units). It resets at midnight Pacific Time.'
        : err.message || `YouTube API error ${res.status}`;
      throw new YouTubeApiError(msg, res.status, reason);
    }
    if (endpoint === 'search') this.searchCalls += 1;
    else this.quotaUsed += cost;
    this.cache.set(cacheKey, { body, expires: Date.now() + this.cacheTtlMs });
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
    return body;
  }

  async resolveChannelId(input) {
    const p = parseChannelInput(input);
    if (!p) throw new YouTubeApiError('Please enter a channel.', 400);
    if (p.type === 'id') return p.value;
    if (p.type === 'handle' || p.type === 'handleOrSearch') {
      const r = await this.request('channels', { part: 'id', forHandle: p.value });
      if (r.items?.length) return r.items[0].id;
      if (p.type === 'handle') throw new YouTubeApiError(`No channel found for ${p.value}`, 404);
    }
    if (p.type === 'username') {
      const r = await this.request('channels', { part: 'id', forUsername: p.value });
      if (r.items?.length) return r.items[0].id;
    }
    const s = await this.request('search', { part: 'snippet', type: 'channel', q: p.value, maxResults: 1 });
    const id = s.items?.[0]?.id?.channelId;
    if (!id) throw new YouTubeApiError(`No channel found for "${p.value}"`, 404);
    return id;
  }

  async getChannels(ids) {
    const out = [];
    for (const group of chunk([...new Set(ids)], 50)) {
      const r = await this.request('channels', {
        part: 'snippet,statistics,contentDetails,brandingSettings',
        id: group.join(','),
        maxResults: 50,
      });
      out.push(...(r.items || []));
    }
    return out;
  }

  async getVideos(ids) {
    const out = [];
    for (const group of chunk([...new Set(ids)], 50)) {
      const r = await this.request('videos', { part: 'snippet,statistics,contentDetails', id: group.join(','), maxResults: 50 });
      out.push(...(r.items || []));
    }
    return out;
  }

  /** Most recent uploads (newest first). `complete` is true when the whole upload history was fetched. */
  async getUploads(channel, max = 50) {
    const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) return { videos: [], complete: true };
    const ids = [];
    let pageToken;
    try {
      do {
        const r = await this.request('playlistItems', {
          part: 'contentDetails', playlistId, maxResults: Math.min(50, max - ids.length), pageToken,
        });
        ids.push(...(r.items || []).map((i) => i.contentDetails.videoId));
        pageToken = r.nextPageToken;
      } while (pageToken && ids.length < max);
    } catch (e) {
      if (e.status === 404) return { videos: [], complete: true }; // channel without uploads
      throw e;
    }
    return { videos: await this.getVideos(ids), complete: !pageToken };
  }

  async searchVideos(q, { max = 25, order = 'relevance', regionCode, relevanceLanguage } = {}) {
    const r = await this.request('search', {
      part: 'snippet', type: 'video', q, order, maxResults: Math.min(50, max), regionCode, relevanceLanguage,
    });
    const ids = (r.items || []).map((i) => i.id.videoId).filter(Boolean);
    // videos.list does not promise to return items in the requested order; restore search-rank order.
    const byId = new Map((await this.getVideos(ids)).map((v) => [v.id, v]));
    // Keep each hit's 1-based search rank: a hit videos.list no longer returns (e.g. made private)
    // must not move the ranks below it. Spread so the cached videos.list response is not mutated.
    return ids.map((id, i) => { const v = byId.get(id); return v && { ...v, searchRank: i + 1 }; }).filter(Boolean);
  }
}
