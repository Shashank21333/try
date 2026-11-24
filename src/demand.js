// Search-demand signals for a keyword. YouTube does not publish search volume,
// so this combines three honest, clearly-labelled sources:
//   1. YouTube autocomplete (free): what people actually type into YouTube search.
//   2. Google Trends with the "YouTube Search" property, via SerpApi (optional SERPAPI_KEY):
//      relative interest 0-100 over time, plus rising/top related queries.
//   3. Keywords Everywhere (optional KE_API_KEY): monthly *Google* search volume from
//      Google Keyword Planner. 1 credit per keyword.
import { TtlCache, mapLimit } from './cache.js';

const DAY = 86_400_000;
const suggestCache = new TtlCache(DAY);
const trendsCache = new TtlCache(6 * 3600_000);
const volumeCache = new TtlCache(7 * DAY);

export const normalizeKeyword = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- 1. YouTube autocomplete ----------

/** Real-time YouTube search suggestions (the same list shown under the YouTube search box). */
export async function fetchSuggestions(q, { hl = 'en', gl, fetchImpl = globalThis.fetch } = {}) {
  const query = String(q || '');
  if (!query.trim()) return [];
  const key = `${hl}|${gl || ''}|${query}`;
  return suggestCache.wrap(key, async () => {
    const url = new URL('https://suggestqueries.google.com/complete/search');
    url.search = new URLSearchParams({ client: 'firefox', ds: 'yt', q: query, hl, ...(gl ? { gl } : {}) });
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`YouTube autocomplete failed (${res.status})`);
    const charset = /charset=([\w-]+)/i.exec(res.headers?.get?.('content-type') || '')?.[1] || 'utf-8';
    const text = new TextDecoder(charset).decode(await res.arrayBuffer());
    const body = JSON.parse(text);
    return Array.isArray(body?.[1]) ? body[1].filter((s) => typeof s === 'string') : [];
  });
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const QUESTION_PREFIXES = ['how to', 'what is', 'why', 'best', 'is'];
const MODIFIER_SUFFIXES = ['for', 'vs', 'without', 'with', 'in', 'kaise', 'tips', 'review'];

/**
 * Keyword ideas by expanding the seed (seed + a..z, question prefixes, modifiers).
 * Each idea records how many different expansions surfaced it and its best position,
 * a proxy for how commonly people search it.
 */
export async function keywordIdeas(seed, opts = {}) {
  const s = normalizeKeyword(seed);
  const queries = [s, ...LETTERS.map((l) => `${s} ${l}`), ...QUESTION_PREFIXES.map((p) => `${p} ${s}`), ...MODIFIER_SUFFIXES.map((m) => `${s} ${m}`)];
  const lists = await mapLimit(queries, 6, (q) => fetchSuggestions(q, opts).catch(() => []));
  const ideas = new Map();
  lists.forEach((list, qi) => list.forEach((raw, pos) => {
    const k = normalizeKeyword(raw);
    if (!k || k === s) return;
    const e = ideas.get(k) || { keyword: k, appearances: 0, bestPosition: Infinity, fromSeedDirectly: false };
    e.appearances += 1;
    e.bestPosition = Math.min(e.bestPosition, pos + 1);
    if (qi === 0) e.fromSeedDirectly = true;
    ideas.set(k, e);
  }));
  const typeOf = (k) => (/^(how|what|why|when|where|which|who|is|can|does|do|should|kaise|kya|kyu)\b/.test(k) || k.includes('?') ? 'question' : 'phrase');
  return [...ideas.values()]
    .map((e) => ({ ...e, type: typeOf(e.keyword) }))
    .sort((a, b) => Number(b.fromSeedDirectly) - Number(a.fromSeedDirectly) || b.appearances - a.appearances || a.bestPosition - b.bestPosition);
}

/** Prefix lengths to probe: every length up to 24 probes, then evenly spaced. */
export function prefixLengths(len, maxProbes = 24) {
  const start = Math.min(2, len);
  const all = Array.from({ length: len - start + 1 }, (_, i) => start + i);
  if (all.length <= maxProbes) return all;
  const step = (all.length - 1) / (maxProbes - 1);
  return [...new Set(Array.from({ length: maxProbes }, (_, i) => all[Math.round(i * step)]))];
}

/**
 * How early does YouTube autocomplete suggest the full keyword while typing it?
 * Popular searches appear after only a few characters. strength = 100 * (1 - (prefixLen - 1) / keywordLen).
 */
export async function autocompleteStrength(keyword, opts = {}) {
  const k = normalizeKeyword(keyword);
  if (!k) return null;
  const lengths = prefixLengths([...k].length);
  const chars = [...k];
  for (let i = 0; i < lengths.length; i += 6) {
    const batch = lengths.slice(i, i + 6);
    const results = await mapLimit(batch, 6, (len) => fetchSuggestions(chars.slice(0, len).join(''), opts).catch(() => []));
    for (let b = 0; b < batch.length; b++) {
      const pos = results[b].findIndex((s) => normalizeKeyword(s) === k);
      if (pos >= 0) {
        const len = batch[b];
        return {
          found: true,
          prefix: chars.slice(0, len).join(''),
          prefixLength: len,
          keywordLength: chars.length,
          position: pos + 1,
          strength: Math.round(100 * (1 - (len - 1) / chars.length)),
        };
      }
    }
  }
  return { found: false, prefix: null, prefixLength: null, keywordLength: chars.length, position: null, strength: 0 };
}

// ---------- 2. Google Trends (YouTube Search) via SerpApi ----------

export function trendsUrl(q, geo) {
  const params = { date: 'today 12-m', gprop: 'youtube', q, ...(geo ? { geo } : {}) };
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `https://trends.google.com/trends/explore?${qs}`;
}

export function trendChange(values) {
  // Average of the most recent 13 points (~3 months of weekly data) vs the 13 before.
  if (values.length < 8) return null;
  const n = Math.min(13, Math.floor(values.length / 2));
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const recent = avg(values.slice(-n));
  const prior = avg(values.slice(-2 * n, -n));
  return prior > 0 ? (recent - prior) / prior : null;
}

export async function fetchTrends(q, { apiKey, geo, hl = 'en', fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return { enabled: false, url: trendsUrl(q, geo) };
  return trendsCache.wrap(`${geo || ''}|${hl}|${q}`, async () => {
    const call = async (dataType) => {
      const u = new URL('https://serpapi.com/search');
      u.search = new URLSearchParams({ engine: 'google_trends', q, gprop: 'youtube', date: 'today 12-m', data_type: dataType, hl, api_key: apiKey, ...(geo ? { geo } : {}) });
      const res = await fetchImpl(u, { signal: AbortSignal.timeout(30_000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) throw new Error(`Google Trends (SerpApi): ${body.error || res.status}`);
      return body;
    };
    const [ts, rq] = await Promise.allSettled([call('TIMESERIES'), call('RELATED_QUERIES')]);
    if (ts.status === 'rejected' && rq.status === 'rejected') throw ts.reason;
    const timeline = ts.status === 'fulfilled'
      ? (ts.value.interest_over_time?.timeline_data || []).map((p) => ({
        date: p.date,
        timestamp: Number(p.timestamp) * 1000,
        value: Number(p.values?.[0]?.extracted_value ?? 0),
      }))
      : [];
    const rel = rq.status === 'fulfilled' ? rq.value.related_queries || {} : {};
    const mapQ = (list) => (list || []).map((r) => ({ query: r.query, label: String(r.value ?? ''), value: Number(r.extracted_value ?? 0) }));
    const values = timeline.map((p) => p.value);
    return {
      enabled: true,
      url: trendsUrl(q, geo),
      timeline,
      change: trendChange(values),
      latest: values.at(-1) ?? null,
      peak: values.length ? Math.max(...values) : null,
      rising: mapQ(rel.rising).slice(0, 15),
      top: mapQ(rel.top).slice(0, 15),
      // "Google Trends has no data" is normal for niche terms: SerpApi returns an empty timeline.
      noData: timeline.length === 0 || values.every((v) => v === 0),
    };
  });
}

// ---------- 3. Keywords Everywhere (Google search volume) ----------

export async function fetchVolumes(keywords, { apiKey, country = 'us', currency = 'usd', fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return { enabled: false };
  const kws = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 100);
  const cacheKey = (k) => `${country}|${currency}|${k}`;
  const cached = new Map();
  const missing = [];
  for (const k of kws) {
    const hit = volumeCache.get(cacheKey(k));
    if (hit) cached.set(k, hit); else missing.push(k);
  }
  let creditsLeft = null;
  let creditsUsed = 0;
  if (missing.length) {
    const body = new URLSearchParams({ dataSource: 'gkp', country, currency });
    for (const k of missing) body.append('kw[]', k);
    const res = await fetchImpl('https://api.keywordseverywhere.com/v1/get_keyword_data', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Keywords Everywhere: ${json.message || json.error || `HTTP ${res.status}`}`);
    creditsLeft = json.credits ?? null;
    creditsUsed = json.credits_consumed ?? null;
    for (const d of json.data || []) {
      const item = {
        keyword: normalizeKeyword(d.keyword),
        volume: Number.isFinite(Number(d.vol)) ? Number(d.vol) : null,
        cpc: d.cpc?.value !== undefined ? Number(d.cpc.value) : null,
        cpcCurrency: d.cpc?.currency || null,
        competition: Number.isFinite(Number(d.competition)) ? Number(d.competition) : null,
        trend: (d.trend || []).map((t) => ({ month: t.month, year: t.year, value: Number(t.value) })),
      };
      cached.set(item.keyword, volumeCache.set(cacheKey(item.keyword), item));
    }
  }
  return {
    enabled: true,
    source: 'Google Keyword Planner via Keywords Everywhere (Google search, not YouTube)',
    country,
    items: kws.map((k) => cached.get(k)).filter(Boolean),
    creditsLeft,
    creditsUsed,
  };
}

// ---------- combined ----------

/**
 * Autocomplete strength + keyword ideas (free), plus Google Trends (SerpApi) and search volume
 * (Keywords Everywhere) when their keys are set. `lite` skips the two paid lookups even when keys are
 * set, so automatic callers (the Chrome extension on every search page) never spend those credits.
 */
export async function searchDemand(q, { region, hl = 'en', serpApiKey, keKey, keMaxKeywords = 20, keCountry, lite = false, fetchImpl } = {}) {
  const keyword = normalizeKeyword(q);
  if (!keyword) throw Object.assign(new Error('Please enter a keyword.'), { status: 400 });
  const gl = region || undefined;
  const settled = async (p) => p.then((value) => ({ value }), (e) => ({ error: e.message || String(e) }));

  const [strength, ideas, trends] = await Promise.all([
    settled(autocompleteStrength(keyword, { hl, gl, fetchImpl })),
    settled(keywordIdeas(keyword, { hl, gl, fetchImpl })),
    lite
      ? { value: { enabled: Boolean(serpApiKey), skipped: true, url: trendsUrl(keyword, region) } }
      : settled(fetchTrends(keyword, { apiKey: serpApiKey, geo: region, hl, fetchImpl })),
  ]);
  const ideaList = ideas.value || [];
  const volume = lite
    ? { value: { enabled: Boolean(keKey), skipped: true } }
    : await settled(fetchVolumes([keyword, ...ideaList.slice(0, keMaxKeywords).map((i) => i.keyword)], {
      apiKey: keKey, country: (keCountry || region || 'us').toLowerCase(), fetchImpl,
    }));

  return {
    keyword,
    region: region || null,
    lite,
    autocomplete: strength.value ? { ...strength.value } : { error: strength.error },
    ideas: ideas.value ? ideaList.slice(0, 80) : { error: ideas.error },
    trends: trends.value || { enabled: Boolean(serpApiKey), url: trendsUrl(keyword, region), error: trends.error },
    volume: volume.value || { enabled: Boolean(keKey), error: volume.error },
  };
}
