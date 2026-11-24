// Pure analytics functions. No I/O here, so everything is unit-testable.

const DAY_MS = 86_400_000;

// YouTube Shorts can be up to 3 minutes long (since Oct 2024). The API has no
// "is Short" flag, so duration is a heuristic: a regular video of <= 3 min
// will also be counted as a Short.
export const SHORT_MAX_SECONDS = 180;

export function parseDuration(iso) {
  if (typeof iso !== 'string') return 0;
  const m = iso.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, w, d, h, min, s] = m;
  return (Number(w) || 0) * 604800 + (Number(d) || 0) * 86400 + (Number(h) || 0) * 3600 +
    (Number(min) || 0) * 60 + Math.round(Number(s) || 0);
}

export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function mean(values) {
  const a = values.filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

const toNum = (v) => (v === undefined || v === null ? null : Number(v));

/** Convert a raw videos.list item into a flat, analysis-friendly object. */
export function normalizeVideo(item, now = Date.now()) {
  const s = item.snippet || {};
  const st = item.statistics || {};
  const cd = item.contentDetails || {};
  const publishedMs = Date.parse(s.publishedAt);
  const ageDays = Number.isFinite(publishedMs) ? Math.max((now - publishedMs) / DAY_MS, 1 / 24) : null;
  const views = toNum(st.viewCount) ?? 0;
  const likes = toNum(st.likeCount);
  const comments = toNum(st.commentCount);
  const durationSec = parseDuration(cd.duration);
  return {
    id: item.id,
    title: s.title || '',
    channelId: s.channelId || null,
    channelTitle: s.channelTitle || '',
    publishedAt: s.publishedAt || null,
    thumbnail: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || null,
    tags: Array.isArray(s.tags) ? s.tags : [],
    durationSec,
    isShort: durationSec > 0 && durationSec <= SHORT_MAX_SECONDS,
    isLive: Boolean(s.liveBroadcastContent && s.liveBroadcastContent !== 'none'),
    views,
    likes,
    comments,
    ageDays,
    viewsPerDay: ageDays ? views / ageDays : null,
    // (likes + comments) / views. When likes are hidden a comments-only rate is not comparable, so null.
    engagementRate: views > 0 && likes !== null ? (likes + (comments || 0)) / views : null,
  };
}

/**
 * Outlier score = views / median views of the same channel *and* same format
 * (Shorts and long-form perform very differently, so they get separate baselines).
 * 1.0 = typical video, 3.0 = 3x the channel's typical views.
 */
export function scoreOutliers(videos) {
  const baseline = {};
  for (const fmt of ['short', 'long']) {
    baseline[fmt] = median(videos.filter((v) => (v.isShort ? 'short' : 'long') === fmt).map((v) => v.views));
  }
  return videos.map((v) => {
    const b = baseline[v.isShort ? 'short' : 'long'];
    return { ...v, outlierScore: b > 0 ? v.views / b : null };
  });
}

export function channelSummary(channel, videos, { now = Date.now(), complete = false } = {}) {
  const sn = channel.snippet || {};
  const st = channel.statistics || {};
  const subs = st.hiddenSubscriberCount ? null : toNum(st.subscriberCount);

  // Uploads/week over the last 90 days. If we did not fetch the whole upload
  // history and our sample is shorter than 90 days, use the sample's span instead.
  let windowDays = 90;
  if (!complete && videos.length) {
    windowDays = Math.min(90, Math.max(...videos.map((v) => v.ageDays || 0)));
  }
  const recent = videos.filter((v) => (v.ageDays ?? Infinity) <= windowDays).length;
  const uploadsPerWeek = windowDays > 0 ? recent / (windowDays / 7) : 0;

  const shorts = videos.filter((v) => v.isShort);
  const long = videos.filter((v) => !v.isShort);
  const medianViews = median(videos.map((v) => v.views));
  const ages = videos.map((v) => v.ageDays).filter(Number.isFinite);

  return {
    id: channel.id,
    title: sn.title || '',
    handle: sn.customUrl || null,
    description: sn.description || '',
    thumbnail: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || null,
    country: sn.country || null,
    createdAt: sn.publishedAt || null,
    keywords: parseChannelKeywords(channel.brandingSettings?.channel?.keywords),
    subscribers: subs,
    totalViews: toNum(st.viewCount),
    totalVideos: toNum(st.videoCount),
    sampleSize: videos.length,
    sampleComplete: complete,
    medianViews,
    avgViews: mean(videos.map((v) => v.views)),
    medianViewsShorts: median(shorts.map((v) => v.views)),
    medianViewsLong: median(long.map((v) => v.views)),
    shortsShare: videos.length ? shorts.length / videos.length : 0,
    avgEngagement: mean(videos.map((v) => v.engagementRate)),
    uploadsPerWeek,
    uploadsWindowDays: Math.round(windowDays),
    daysSinceLastUpload: ages.length ? Math.min(...ages) : null,
    viewsPerSubscriber: subs ? medianViews / subs : null,
  };
}

/** brandingSettings.channel.keywords is a space-separated string where multi-word keywords are quoted. */
export function parseChannelKeywords(str) {
  if (!str) return [];
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push((m[1] || m[2]).trim());
  return out.filter(Boolean);
}

export const STOP_WORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
  'just me my no not of on or our out so than that the their them then there these they this to too up us ' +
  'was we were what when where which who why will with you your yours vs ft feat official video videos ' +
  'part ep episode new full get got im dont doesnt ive youre all one more most about after before over ' +
  'every here only very really some any its it\'s'
).split(/\s+/));

export function tokenize(text) {
  const raw = String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu) || [];
  return raw
    .map((t) => t.replace(/['’]s$/u, '').replace(/['’]/gu, ''))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Keywords (single words and two-word phrases) found in titles, with how many
 * videos use them and how those videos perform relative to their channel.
 */
export function keywordStats(videos, { minVideos = 2, limit = 40, exclude = [] } = {}) {
  const skip = new Set(exclude.flatMap((e) => tokenize(e)));
  const map = new Map();
  for (const v of videos) {
    const toks = tokenize(v.title);
    const terms = new Set(toks.filter((t) => !skip.has(t)));
    for (let i = 0; i < toks.length - 1; i++) {
      if (!(skip.has(toks[i]) && skip.has(toks[i + 1]))) terms.add(`${toks[i]} ${toks[i + 1]}`);
    }
    for (const term of terms) {
      if (!map.has(term)) map.set(term, { term, videos: [], channels: new Set() });
      const e = map.get(term);
      e.videos.push(v);
      if (v.channelTitle) e.channels.add(v.channelTitle);
    }
  }
  return [...map.values()]
    .filter((e) => e.videos.length >= minVideos)
    .map((e) => ({
      term: e.term,
      count: e.videos.length,
      channels: [...e.channels],
      medianViews: median(e.videos.map((v) => v.views)),
      medianScore: median(e.videos.map((v) => v.outlierScore)),
    }))
    .sort((a, b) => b.count - a.count || b.medianScore - a.medianScore)
    .slice(0, limit);
}

export function tagStats(videos, { limit = 40 } = {}) {
  const map = new Map();
  for (const v of videos) {
    for (const raw of new Set(v.tags.map((t) => t.toLowerCase().trim()))) {
      if (!raw) continue;
      if (!map.has(raw)) map.set(raw, { tag: raw, videos: [] });
      map.get(raw).videos.push(v);
    }
  }
  return [...map.values()]
    .map((e) => ({
      tag: e.tag,
      count: e.videos.length,
      medianViews: median(e.videos.map((v) => v.views)),
      medianScore: median(e.videos.map((v) => v.outlierScore)),
    }))
    .sort((a, b) => b.count - a.count || b.medianScore - a.medianScore)
    .slice(0, limit);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Upload day/hour vs performance. tzOffsetMinutes uses the JS
 * Date#getTimezoneOffset convention (UTC - local, e.g. IST = -330).
 * Uses outlier score so channels of different sizes are comparable.
 */
export function postingSchedule(videos, tzOffsetMinutes = 0) {
  const days = DAYS.map((day) => ({ day, items: [] }));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, items: [] }));
  for (const v of videos) {
    const t = Date.parse(v.publishedAt);
    if (!Number.isFinite(t)) continue;
    const local = new Date(t - tzOffsetMinutes * 60_000);
    days[local.getUTCDay()].items.push(v);
    hours[local.getUTCHours()].items.push(v);
  }
  const fold = ({ items, ...rest }) => ({
    ...rest,
    count: items.length,
    medianScore: median(items.map((v) => v.outlierScore)),
    medianViews: median(items.map((v) => v.views)),
  });
  return { days: days.map(fold), hours: hours.map(fold) };
}

export const TITLE_FEATURES = [
  { key: 'number', label: 'Contains a number', test: (t) => /\d/.test(t) },
  { key: 'question', label: 'Asks a question (?)', test: (t) => t.includes('?') },
  { key: 'brackets', label: 'Uses ( ) or [ ]', test: (t) => /[[\]()]/.test(t) },
  { key: 'caps', label: 'Has an ALL-CAPS word', test: (t) => /\b\p{Lu}{3,}\b/u.test(t) },
  { key: 'emoji', label: 'Contains emoji', test: (t) => /\p{Extended_Pictographic}/u.test(t) },
  { key: 'separator', label: 'Uses | or :', test: (t) => /[|:]/.test(t) },
  { key: 'you', label: 'Says "you"/"your"', test: (t) => /\byou(r)?\b/i.test(t) },
  { key: 'long', label: 'Longer than 60 characters', test: (t) => [...t].length > 60 },
];

/** For each title feature: share of videos using it and median outlier score with vs without. */
export function titlePatterns(videos) {
  const lengths = videos.map((v) => [...v.title].length);
  return {
    medianLength: median(lengths),
    features: TITLE_FEATURES.map((f) => {
      const yes = videos.filter((v) => f.test(v.title));
      const no = videos.filter((v) => !f.test(v.title));
      const withScore = median(yes.map((v) => v.outlierScore));
      const withoutScore = median(no.map((v) => v.outlierScore));
      return {
        key: f.key,
        label: f.label,
        share: videos.length ? yes.length / videos.length : 0,
        count: yes.length,
        withScore,
        withoutScore,
        lift: yes.length >= 3 && no.length >= 3 && withoutScore > 0 ? withScore / withoutScore : null,
      };
    }),
  };
}

export function formatBreakdown(videos) {
  const group = (list) => ({
    count: list.length,
    medianViews: median(list.map((v) => v.views)),
    avgEngagement: mean(list.map((v) => v.engagementRate)),
    medianDurationSec: median(list.map((v) => v.durationSec)),
  });
  return { shorts: group(videos.filter((v) => v.isShort)), long: group(videos.filter((v) => !v.isShort)) };
}

const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

/**
 * Keyword opportunity heuristic from the top search results for a query.
 * demand: how many views/day the top results earn (log scale, 100k/day = 100).
 * competition: how big the ranking channels are (log scale, 10M subs = 100).
 * These are rough, transparent heuristics, not YouTube's own search volume.
 */
export function keywordOpportunity(videos) {
  const vpd = median(videos.map((v) => v.viewsPerDay));
  const subsList = videos.map((v) => v.channelSubscribers).filter(Number.isFinite);
  const medSubs = median(subsList);
  const demand = clamp((Math.log10(vpd + 1) / 5) * 100);
  const competition = clamp((Math.log10(medSubs + 1) / 7) * 100);
  return {
    resultCount: videos.length,
    medianViews: median(videos.map((v) => v.views)),
    medianViewsPerDay: vpd,
    medianChannelSubscribers: medSubs,
    smallChannelShare: subsList.length ? subsList.filter((s) => s < 100_000).length / subsList.length : 0,
    recentShare: videos.length ? videos.filter((v) => v.ageDays <= 180).length / videos.length : 0,
    // Videos with more views than their channel has subscribers: a sign the topic can carry small channels.
    overperformers: videos.filter((v) => v.channelSubscribers && v.views > v.channelSubscribers).length,
    demand: Math.round(demand),
    competition: Math.round(competition),
    opportunity: Math.round(clamp(demand * 0.6 + (100 - competition) * 0.4)),
  };
}
