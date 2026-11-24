// Feature: Audit. Video SEO score (GET /api/video) and channel audit (GET /api/audit/channel).
// The scoring itself lives in src/seo.js (pure, unit-tested); this file only fetches data.
//
// Quota (YouTube Data API units, cached 15 min by the client):
//   /api/video          videos.list + channels.list + playlistItems.list + videos.list = ~4
//   /api/audit/channel  ~2 per 50 uploads + 1 for the channel (+1 for an @handle, +100 for a name search)
import { normalizeVideo, scoreOutliers, channelSummary } from '../analytics.js';
import { scoreVideo, parseVideoId, cleanKeyword, auditChannel, formatBaselines } from '../seo.js';

const RECENT_UPLOADS = 50; // baseline sample for the video audit

export function create(ctx) {
  const { httpError, intParam, meta } = ctx;

  /** Channel summary + same-format baselines from the channel's recent uploads. */
  async function channelContext(channelId, now) {
    const [rawChannel] = await ctx.client.getChannels([channelId]);
    if (!rawChannel) return { channel: null, baselines: null };
    const { videos, complete } = await ctx.client.getUploads(rawChannel, RECENT_UPLOADS);
    const recent = scoreOutliers(videos.map((v) => normalizeVideo(v, now)).filter((v) => !v.isLive));
    return { channel: channelSummary(rawChannel, recent, { now, complete }), baselines: formatBaselines(recent) };
  }

  return {
    routes: {
      // Contract relied on by the Chrome extension: { video, channel, outlierScore, seo, meta }.
      // `tz` is accepted (the frontend sends it with every request) but not needed here.
      'GET /api/video': async (url) => {
        const raw = url.searchParams.get('id');
        if (!raw || !raw.trim()) throw httpError(400, 'Enter a YouTube video URL or 11-character video ID.');
        const id = parseVideoId(raw);
        if (!id) throw httpError(400, 'That does not look like a YouTube video URL or 11-character video ID.');
        const keyword = cleanKeyword(url.searchParams.get('keyword'));

        const [item] = await ctx.client.getVideos([id]);
        if (!item) throw httpError(404, 'Video not found. It may be private, deleted, or the ID may be wrong.');
        const now = Date.now();
        const v = normalizeVideo(item, now);

        const { channel, baselines } = v.channelId ? await channelContext(v.channelId, now) : { channel: null, baselines: null };
        const base = baselines?.[v.isShort ? 'short' : 'long'];
        const outlierScore = base?.medianViews > 0 ? v.views / base.medianViews : null;
        const seo = scoreVideo(item, { keyword, context: base });

        return {
          video: {
            id: v.id,
            title: v.title,
            channelId: v.channelId,
            channelTitle: v.channelTitle,
            publishedAt: v.publishedAt,
            views: v.views,
            likes: v.likes,
            comments: v.comments,
            durationSec: v.durationSec,
            isShort: v.isShort,
            ageDays: v.ageDays,
            viewsPerDay: v.viewsPerDay,
            engagementRate: v.engagementRate,
            tags: v.tags,
            thumbnail: v.thumbnail,
            description: item.snippet?.description || '',
          },
          channel,
          outlierScore,
          seo: { score: seo.score, grade: seo.grade, checks: seo.checks },
          meta: meta(),
        };
      },

      'GET /api/audit/channel': async (url) => {
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q) throw httpError(400, 'Enter a channel URL, @handle or channel ID.');
        const max = intParam(url.searchParams.get('max'), 50, 10, 200);
        const id = await ctx.client.resolveChannelId(q);
        const [rawChannel] = await ctx.client.getChannels([id]);
        if (!rawChannel) throw httpError(404, `Channel not found: ${q}`);
        const { videos, complete } = await ctx.client.getUploads(rawChannel, max);
        return { ...auditChannel(rawChannel, videos, { now: Date.now(), complete }), meta: meta() };
      },
    },
  };
}
