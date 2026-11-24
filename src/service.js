// Orchestration: fetch data with a client (real or demo) and run analytics.
import {
  normalizeVideo, scoreOutliers, channelSummary, keywordStats, tagStats,
  postingSchedule, titlePatterns, formatBreakdown, keywordOpportunity, median,
} from './analytics.js';

export const MAX_COMPETITORS = 8;

export async function loadChannel(client, input, { max = 50, now = Date.now() } = {}) {
  const id = await client.resolveChannelId(input);
  const [raw] = await client.getChannels([id]);
  if (!raw) {
    const err = new Error(`Channel not found: ${input}`);
    err.status = 404;
    throw err;
  }
  const { videos, complete } = await client.getUploads(raw, max);
  const normalized = videos.map((v) => normalizeVideo(v, now)).filter((v) => !v.isLive);
  const scored = scoreOutliers(normalized);
  return { channel: channelSummary(raw, scored, { now, complete }), videos: scored };
}

const topOutliers = (videos, n = 20) =>
  videos.filter((v) => v.outlierScore !== null && v.ageDays >= 2)
    .sort((a, b) => b.outlierScore - a.outlierScore)
    .slice(0, n);

export async function analyzeChannel(client, input, { tz = 0, ...opts } = {}) {
  const { channel, videos } = await loadChannel(client, input, opts);
  return {
    channel,
    videos,
    outliers: topOutliers(videos, 12),
    formats: formatBreakdown(videos),
    keywords: keywordStats(videos),
    tags: tagStats(videos),
    schedule: postingSchedule(videos, tz),
    titlePatterns: titlePatterns(videos),
  };
}

export async function compareChannels(client, inputs, { tz = 0, ...opts } = {}) {
  const list = [...new Set(inputs.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_COMPETITORS);
  const settled = await Promise.allSettled(list.map((i) => loadChannel(client, i, opts)));
  const loaded = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') loaded.push(r.value);
    else errors.push({ input: list[i], message: r.reason?.message || String(r.reason), status: r.reason?.status });
  });
  // Outlier scores are already relative to each video's own channel, so they are comparable across channels.
  const all = loaded.flatMap((c) => c.videos);
  return {
    channels: loaded.map((c) => c.channel),
    errors,
    outliers: topOutliers(all, 24),
    keywords: keywordStats(all, { minVideos: 3, limit: 50 }),
    tags: tagStats(all, { limit: 40 }),
    schedule: postingSchedule(all, tz),
    titlePatterns: titlePatterns(all),
  };
}

export async function researchKeyword(client, query, { max = 25, now = Date.now(), regionCode } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    const err = new Error('Please enter a keyword.');
    err.status = 400;
    throw err;
  }
  const raw = await client.searchVideos(q, { max, regionCode });
  const videos = raw.map((v) => normalizeVideo(v, now)).filter((v) => !v.isLive);
  const chans = await client.getChannels(videos.map((v) => v.channelId).filter(Boolean));
  const byId = new Map(chans.map((c) => [c.id, c]));

  const enriched = videos.map((v, rank) => {
    const st = byId.get(v.channelId)?.statistics || {};
    const subs = st.hiddenSubscriberCount ? null : Number(st.subscriberCount ?? NaN);
    const channelSubscribers = Number.isFinite(subs) ? subs : null;
    return {
      ...v,
      rank: rank + 1,
      channelSubscribers,
      viewsToSubs: channelSubscribers ? v.views / channelSubscribers : null,
      outlierScore: channelSubscribers ? v.views / channelSubscribers : null,
    };
  });

  const channelMap = new Map();
  for (const v of enriched) {
    if (!channelMap.has(v.channelId)) {
      const c = byId.get(v.channelId);
      channelMap.set(v.channelId, {
        id: v.channelId,
        title: v.channelTitle,
        handle: c?.snippet?.customUrl || null,
        thumbnail: c?.snippet?.thumbnails?.default?.url || null,
        subscribers: v.channelSubscribers,
        appearances: 0,
        bestRank: v.rank,
        views: [],
      });
    }
    const e = channelMap.get(v.channelId);
    e.appearances += 1;
    e.views.push(v.views);
  }
  const channels = [...channelMap.values()]
    .map(({ views, ...c }) => ({ ...c, medianViews: median(views) }))
    .sort((a, b) => b.appearances - a.appearances || a.bestRank - b.bestRank);

  return {
    query: q,
    summary: keywordOpportunity(enriched),
    videos: enriched,
    channels,
    relatedKeywords: keywordStats(enriched, { minVideos: 2, limit: 30, exclude: [q] }),
    tags: tagStats(enriched, { limit: 30 }),
  };
}
