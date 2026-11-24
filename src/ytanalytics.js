// Private analytics for the connected channel via the YouTube Analytics API v2.
// Note: impressions and impressions click-through rate are NOT available in this API
// (YouTube only exposes them in YouTube Studio and the bulk Reporting API).
const REPORTS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
const DATA_API = 'https://www.googleapis.com/youtube/v3';
const DAY = 86_400_000;

export const TRAFFIC_LABELS = {
  YT_SEARCH: 'YouTube search',
  RELATED_VIDEO: 'Suggested videos',
  SUBSCRIBER: 'Browse features',
  SHORTS: 'Shorts feed',
  EXT_URL: 'External (incl. Google Search)',
  NO_LINK_OTHER: 'Direct or unknown',
  YT_CHANNEL: 'Channel pages',
  PLAYLIST: 'Playlists',
  YT_PLAYLIST_PAGE: 'Playlist pages',
  YT_OTHER_PAGE: 'Other YouTube features',
  NOTIFICATION: 'Notifications',
  END_SCREEN: 'End screens',
  ANNOTATION: 'Cards and annotations',
  CAMPAIGN_CARD: 'Campaign cards',
  NO_LINK_EMBEDDED: 'Embedded players',
  HASHTAGS: 'Hashtag pages',
  ADVERTISING: 'YouTube advertising',
  PROMOTED: 'Promoted',
  LIVE_REDIRECT: 'Live redirect',
  SOUND_PAGE: 'Sound pages',
  VIDEO_REMIXES: 'Remixed videos',
  PRODUCT_PAGE: 'Product pages',
};

export const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Turn a reports.query response into an array of objects keyed by column name. */
export function rowsToObjects(body) {
  const cols = (body.columnHeaders || []).map((c) => c.name);
  return (body.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

export class ChannelAnalytics {
  constructor({ oauth, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.oauth = oauth;
    this.fetch = fetchImpl;
    this.now = now;
  }

  async #get(url) {
    const token = await this.oauth.getAccessToken();
    if (!token) throw Object.assign(new Error('Connect your YouTube channel first.'), { status: 401 });
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status === 401 ? 401 : res.status });
    }
    return body;
  }

  report(params) {
    const u = new URL(REPORTS_URL);
    u.search = new URLSearchParams({ ids: 'channel==MINE', ...params });
    return this.#get(u).then(rowsToObjects);
  }

  data(endpoint, params) {
    const u = new URL(`${DATA_API}/${endpoint}`);
    u.search = new URLSearchParams(params);
    return this.#get(u);
  }

  async myChannel() {
    const r = await this.data('channels', { part: 'snippet,statistics', mine: 'true' });
    const c = r.items?.[0];
    if (!c) throw Object.assign(new Error('This Google account has no YouTube channel.'), { status: 404 });
    return {
      id: c.id,
      title: c.snippet?.title,
      handle: c.snippet?.customUrl || null,
      thumbnail: c.snippet?.thumbnails?.default?.url || null,
      subscribers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount),
      views: Number(c.statistics?.viewCount),
      videos: Number(c.statistics?.videoCount),
    };
  }

  async overview(days = 28) {
    // Analytics data lags by a couple of days; end at "yesterday" and the API returns what it has.
    const end = this.now() - DAY;
    const start = end - (days - 1) * DAY;
    const prevEnd = start - DAY;
    const prevStart = prevEnd - (days - 1) * DAY;
    const range = { startDate: isoDate(start), endDate: isoDate(end) };
    const core = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares';

    const jobs = {
      channel: this.myChannel(),
      totals: this.report({ ...range, metrics: core }),
      previous: this.report({ startDate: isoDate(prevStart), endDate: isoDate(prevEnd), metrics: core }),
      daily: this.report({ ...range, dimensions: 'day', sort: 'day', metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost' }),
      traffic: this.report({ ...range, dimensions: 'insightTrafficSourceType', metrics: 'views,estimatedMinutesWatched' }),
      searchTerms: this.report({ ...range, dimensions: 'insightTrafficSourceDetail', filters: 'insightTrafficSourceType==YT_SEARCH', metrics: 'views,estimatedMinutesWatched', sort: '-views', maxResults: '25' }),
      topVideos: this.report({ ...range, dimensions: 'video', metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained', sort: '-views', maxResults: '25' }),
      demographics: this.report({ ...range, dimensions: 'ageGroup,gender', metrics: 'viewerPercentage' }),
      geography: this.report({ ...range, dimensions: 'country', metrics: 'views,estimatedMinutesWatched' }),
    };
    const scopes = await this.oauth.grantedScopes();
    if (scopes.some((s) => s.endsWith('yt-analytics-monetary.readonly'))) {
      jobs.revenue = this.report({ ...range, metrics: 'estimatedRevenue,cpm,playbackBasedCpm' });
    }
    const keys = Object.keys(jobs);
    const settled = await Promise.allSettled(Object.values(jobs));
    const out = { range: { ...range, days } };
    const errors = {};
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') out[keys[i]] = s.value;
      else { errors[keys[i]] = s.reason.message; if (s.reason.status === 401 && keys[i] === 'channel') throw s.reason; }
    });

    // Attach titles/thumbnails to top videos (1 Data API call).
    if (out.topVideos?.length) {
      try {
        const r = await this.data('videos', { part: 'snippet', id: out.topVideos.map((v) => v.video).join(',') });
        const meta = new Map((r.items || []).map((v) => [v.id, v.snippet]));
        out.topVideos = out.topVideos.map((v) => ({ ...v, title: meta.get(v.video)?.title || v.video, thumbnail: meta.get(v.video)?.thumbnails?.medium?.url || null, publishedAt: meta.get(v.video)?.publishedAt || null }));
      } catch (e) { errors.topVideoTitles = e.message; }
    }
    if (out.traffic) {
      const total = out.traffic.reduce((s, r) => s + r.views, 0) || 1;
      out.traffic = out.traffic.map((r) => ({ ...r, label: TRAFFIC_LABELS[r.insightTrafficSourceType] || r.insightTrafficSourceType, share: r.views / total })).sort((a, b) => b.views - a.views);
    }
    if (out.geography) {
      const total = out.geography.reduce((s, r) => s + r.views, 0) || 1;
      out.geography = out.geography.map((r) => ({ ...r, share: r.views / total })).sort((a, b) => b.views - a.views).slice(0, 25);
    }
    out.totals = out.totals?.[0] || null;
    out.previous = out.previous?.[0] || null;
    out.revenue = out.revenue?.[0] || (jobs.revenue ? null : undefined);
    out.errors = errors;
    return out;
  }

  async retention(videoId) {
    if (!/^[\w-]{11}$/.test(videoId || '')) throw Object.assign(new Error('Invalid video ID.'), { status: 400 });
    const r = await this.data('videos', { part: 'snippet,contentDetails', id: videoId });
    const v = r.items?.[0];
    if (!v) throw Object.assign(new Error('Video not found.'), { status: 404 });
    const rows = await this.report({
      startDate: isoDate(Date.parse(v.snippet.publishedAt)),
      endDate: isoDate(this.now()),
      dimensions: 'elapsedVideoTimeRatio',
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
      filters: `video==${videoId}`,
    });
    return { videoId, title: v.snippet.title, duration: v.contentDetails?.duration, points: rows };
  }
}
