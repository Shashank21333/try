import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fetchSuggestions, keywordIdeas, autocompleteStrength, prefixLengths, trendsUrl, trendChange,
  fetchTrends, fetchVolumes, searchDemand,
} from '../src/demand.js';
import { JsonStore } from '../src/store.js';
import { Tracker, channelReport } from '../src/tracker.js';
import { DemoClient } from '../src/demo.js';
import { GoogleOAuth } from '../src/oauth.js';
import { ChannelAnalytics, rowsToObjects } from '../src/ytanalytics.js';

const json = (body, status = 200) => ({
  ok: status < 400, status, json: async () => body,
  headers: { get: () => 'text/javascript; charset=UTF-8' },
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
});
const tmp = () => mkdtemp(path.join(tmpdir(), 'tubescout-'));

// Fake YouTube autocomplete: suggests "<prefix>... budget phone review" style entries.
const SUGGEST_DB = ['budget phone', 'budget phone review', 'how to budget phone setup', 'budget phone under 10000', 'budget phone vs flagship'];
const fakeSuggest = (calls = []) => async (url) => {
  const u = new URL(url);
  calls.push(u.searchParams.get('q'));
  const q = u.searchParams.get('q').toLowerCase();
  if (u.hostname !== 'suggestqueries.google.com') throw new Error('unexpected host');
  // the full keyword is only suggested once 7+ characters of it are typed
  const hits = SUGGEST_DB.filter((s) => s.startsWith(q) && (s !== 'budget phone' || q.length >= 7));
  const extra = q.startsWith('budget phone ') ? [`${q}x idea`] : [];
  return json([q, [...hits, ...extra]]);
};

test('fetchSuggestions parses autocomplete JSON and sends ds=yt', async () => {
  let seen;
  const r = await fetchSuggestions('budget ph', { hl: 'en', gl: 'IN', fetchImpl: async (u) => { seen = new URL(u); return json(['budget ph', ['budget phone']]); } });
  assert.deepEqual(r, ['budget phone']);
  assert.equal(seen.searchParams.get('ds'), 'yt');
  assert.equal(seen.searchParams.get('gl'), 'IN');
});

test('prefixLengths caps the number of probes', () => {
  assert.deepEqual(prefixLengths(5), [2, 3, 4, 5]);
  const many = prefixLengths(60, 24);
  assert.ok(many.length <= 24);
  assert.equal(many[0], 2);
  assert.equal(many.at(-1), 60);
});

test('autocompleteStrength finds the shortest prefix that suggests the keyword', async () => {
  const s = await autocompleteStrength('Budget  Phone', { fetchImpl: fakeSuggest() });
  assert.equal(s.found, true);
  assert.equal(s.prefix, 'budget ');
  assert.equal(s.prefixLength, 7);
  assert.equal(s.strength, Math.round(100 * (1 - 6 / 12)));
  const none = await autocompleteStrength('zzz unknown', { fetchImpl: async () => json(['', []]) });
  assert.equal(none.found, false);
  assert.equal(none.strength, 0);
});

test('keywordIdeas expands the seed and classifies questions', async () => {
  const calls = [];
  const ideas = await keywordIdeas('budget phone', { fetchImpl: fakeSuggest(calls), hl: 'xx' });
  assert.ok(calls.length > 30, 'expands with a-z, prefixes and modifiers');
  const kw = ideas.map((i) => i.keyword);
  assert.ok(kw.includes('budget phone review'));
  assert.ok(!kw.includes('budget phone'), 'seed itself excluded');
  assert.equal(ideas.find((i) => i.keyword === 'how to budget phone setup')?.type, 'question');
  assert.equal(ideas.find((i) => i.keyword === 'budget phone review')?.type, 'phrase');
  assert.equal(ideas[0].fromSeedDirectly, true);
});

test('trendsUrl uses the YouTube property and %20 spaces', () => {
  assert.equal(trendsUrl('budget phone', 'IN'), 'https://trends.google.com/trends/explore?date=today%2012-m&gprop=youtube&q=budget%20phone&geo=IN');
});

test('trendChange compares the last 13 points with the 13 before', () => {
  assert.equal(trendChange([1, 2, 3]), null);
  const v = [...Array(13).fill(50), ...Array(13).fill(75)];
  assert.equal(trendChange(v), 0.5);
});

test('fetchTrends maps SerpApi responses (gprop=youtube) and is skipped without a key', async () => {
  assert.equal((await fetchTrends('x', {})).enabled, false);
  const seen = [];
  const fetchImpl = async (u) => {
    const url = new URL(u);
    seen.push(url);
    if (url.searchParams.get('data_type') === 'TIMESERIES') {
      return json({ interest_over_time: { timeline_data: [
        { date: 'A', timestamp: '1700000000', values: [{ extracted_value: 40 }] },
        { date: 'B', timestamp: '1700604800', values: [{ extracted_value: 80 }] },
      ] } });
    }
    return json({ related_queries: { rising: [{ query: 'budget phone 2026', value: 'Breakout', extracted_value: 5000 }], top: [{ query: 'best budget phone', value: '100', extracted_value: 100 }] } });
  };
  const t = await fetchTrends('budget phone test', { apiKey: 'K', geo: 'IN', fetchImpl });
  assert.equal(t.enabled, true);
  assert.deepEqual(t.timeline.map((p) => p.value), [40, 80]);
  assert.equal(t.timeline[0].timestamp, 1700000000 * 1000);
  assert.equal(t.rising[0].label, 'Breakout');
  assert.equal(t.top[0].query, 'best budget phone');
  assert.ok(seen.every((u) => u.searchParams.get('gprop') === 'youtube' && u.searchParams.get('engine') === 'google_trends'));
});

test('fetchVolumes posts kw[] to Keywords Everywhere, maps fields, and caches', async () => {
  assert.equal((await fetchVolumes(['a'], {})).enabled, false);
  let calls = 0;
  let body;
  let headers;
  const fetchImpl = async (u, init) => {
    calls++;
    body = init.body;
    headers = init.headers;
    assert.equal(u, 'https://api.keywordseverywhere.com/v1/get_keyword_data');
    return json({
      data: [{ keyword: 'vol test one', vol: 90500, cpc: { currency: '$', value: '9.96' }, competition: 0.62, trend: [{ month: 'January', year: 2026, value: 110000 }] }],
      credits: 1000, credits_consumed: 1,
    });
  };
  const r = await fetchVolumes(['Vol Test One'], { apiKey: 'K', country: 'in', fetchImpl });
  assert.equal(headers.Authorization, 'Bearer K');
  assert.deepEqual(body.getAll('kw[]'), ['vol test one']);
  assert.equal(body.get('country'), 'in');
  assert.equal(body.get('dataSource'), 'gkp');
  assert.equal(r.items[0].volume, 90500);
  assert.equal(r.items[0].cpc, 9.96);
  assert.equal(r.creditsLeft, 1000);
  await fetchVolumes(['vol test one'], { apiKey: 'K', country: 'in', fetchImpl });
  assert.equal(calls, 1, 'second lookup served from cache');
  await assert.rejects(fetchVolumes(['other kw'], { apiKey: 'K', fetchImpl: async () => json({ message: 'Invalid API key' }, 401) }), /Invalid API key/);
});

test('searchDemand isolates failures of optional sources', async () => {
  const fetchImpl = async (u, init) => {
    const host = new URL(u).hostname;
    if (host === 'suggestqueries.google.com') return fakeSuggest()(u);
    if (host === 'serpapi.com') return json({ error: 'Invalid API key' }, 401);
    return json({ data: [] });
  };
  const d = await searchDemand('budget phone', { serpApiKey: 'bad', keKey: 'K', fetchImpl, hl: 'yy' });
  assert.equal(d.autocomplete.found, true);
  assert.ok(Array.isArray(d.ideas) && d.ideas.length > 0);
  assert.match(d.trends.error, /Invalid API key/);
  assert.equal(d.volume.enabled, true);
  await assert.rejects(searchDemand('  '), /keyword/);
});

test('JsonStore writes atomically, serializes updates, and restricts file modes', async () => {
  const dir = await tmp();
  try {
    const s = new JsonStore(dir);
    assert.equal(await s.read('missing', 42), 42);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.update('counter', 0, (n) => n + i + 1 - i)));
    assert.equal(await s.read('counter', 0), 20);
    await s.write('secret', { a: 1 }, { mode: 0o600 });
    assert.equal((await stat(path.join(dir, 'secret.json'))).mode & 0o777, 0o600);
    await assert.rejects(s.read('../evil'), /Invalid store key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('channelReport computes deltas, trending videos and new uploads', () => {
  const DAY = 86_400_000;
  const T0 = Date.parse('2026-11-01T00:00:00Z');
  const vids = (dayIdx, hot) => [
    { id: 'a', title: 'A', publishedAt: '2026-10-01T00:00:00Z', views: 1000 + dayIdx * 10, isShort: false },
    { id: 'b', title: 'B', publishedAt: '2026-10-05T00:00:00Z', views: 2000 + dayIdx * 10, isShort: false },
    { id: 'c', title: 'C', publishedAt: '2026-10-10T00:00:00Z', views: 500 + dayIdx * (hot ? 500 : 10), isShort: false },
  ];
  const snaps = Array.from({ length: 31 }, (_, i) => ({ t: T0 + i * DAY, subs: 1000 + i * 10, views: 100000 + i * 1000, videoCount: 50 + Math.floor(i / 10), videos: vids(i, i === 30) }));
  snaps.at(-1).videos.push({ id: 'n', title: 'New', publishedAt: new Date(T0 + 29.5 * DAY).toISOString(), views: 400, isShort: true });
  const r = channelReport(snaps);
  assert.equal(r.summary.d1.subs, 10);
  assert.equal(r.summary.d7.subs, 70);
  assert.equal(r.summary.d30.subs, 300);
  assert.equal(r.summary.d30.partial, false);
  assert.equal(r.summary.d7.viewsPerDay, 1000);
  assert.equal(r.summary.d30.videos, 3);
  const c = r.trending.find((v) => v.id === 'c');
  assert.ok(c, 'video c is trending');
  // views went from 500+29*10=790 to 500+30*500=15500 in one day; the other videos gained 10/day
  assert.equal(c.gainPerDay, 15500 - 790);
  assert.equal(c.ratio, (15500 - 790) / 10);
  assert.ok(r.trending.some((v) => v.id === 'n' && v.isNew), 'new fast video flagged');
  assert.ok(!r.trending.some((v) => v.id === 'a'));
  assert.deepEqual(r.newUploads.map((v) => v.id), ['n']);
  // single snapshot: no deltas, no trending
  const one = channelReport(snaps.slice(0, 1));
  assert.equal(one.summary.d7, null);
  assert.equal(one.trending.length, 0);
});

test('Tracker adds, snapshots on schedule, reports, and removes channels', async () => {
  const dir = await tmp();
  try {
    let now = Date.parse('2026-11-24T12:00:00Z');
    const client = new DemoClient({ now });
    const tracker = new Tracker({ client, store: new JsonStore(dir), now: () => now });
    const { id, added } = await tracker.add('@rival');
    assert.equal(added, true);
    assert.equal((await tracker.add('@rival')).added, false, 'no duplicates');
    assert.equal((await tracker.runDue()).length, 0, 'fresh snapshot not due yet');
    now += 21 * 3600_000;
    assert.deepEqual((await tracker.runDue()).map((r) => r.ok), [true]);
    const rep = await tracker.report();
    assert.equal(rep.channels[0].snapshots, 2);
    assert.ok(rep.channels[0].d1);
    await tracker.remove(id);
    assert.equal((await tracker.report()).channels.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GoogleOAuth: auth URL, state check, code exchange, refresh', async () => {
  const dir = await tmp();
  try {
    let now = 1_000_000;
    const posts = [];
    const fetchImpl = async (u, init) => {
      posts.push(Object.fromEntries(init.body));
      if (init.body.get('grant_type') === 'authorization_code') return json({ access_token: 'AT1', refresh_token: 'RT', expires_in: 3600, scope: 's1 s2' });
      return json({ access_token: 'AT2', expires_in: 3600 });
    };
    const o = new GoogleOAuth({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost:3000/auth/google/callback', store: new JsonStore(dir), fetchImpl, now: () => now });
    const u = new URL(o.authUrl());
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.match(u.searchParams.get('scope'), /yt-analytics\.readonly/);
    assert.doesNotMatch(u.searchParams.get('scope'), /monetary/);
    await assert.rejects(o.handleCallback({ code: 'c', state: 'forged' }), /expired or was tampered/);
    await o.handleCallback({ code: 'c', state: u.searchParams.get('state') });
    await assert.rejects(o.handleCallback({ code: 'c', state: u.searchParams.get('state') }), /expired/, 'state is single-use');
    assert.equal(await o.getAccessToken(), 'AT1');
    now += 3600_000;
    assert.equal(await o.getAccessToken(), 'AT2');
    assert.equal(posts.at(-1).grant_type, 'refresh_token');
    assert.equal(posts.at(-1).refresh_token, 'RT');
    assert.deepEqual(await o.grantedScopes(), ['s1', 's2']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ChannelAnalytics queries channel==MINE and shapes the overview', async () => {
  const rowsToObjectsOut = rowsToObjects({ columnHeaders: [{ name: 'day' }, { name: 'views' }], rows: [['2026-11-01', 5]] });
  assert.deepEqual(rowsToObjectsOut, [{ day: '2026-11-01', views: 5 }]);

  const seen = [];
  const fetchImpl = async (u, init) => {
    const url = new URL(u);
    seen.push(url);
    assert.equal(init.headers.Authorization, 'Bearer TOKEN');
    if (url.pathname.endsWith('/channels')) return json({ items: [{ id: 'UC1', snippet: { title: 'Me' }, statistics: { subscriberCount: '10', viewCount: '100', videoCount: '3' } }] });
    if (url.pathname.endsWith('/videos')) return json({ items: [{ id: 'vid00000001', snippet: { title: 'My video' } }] });
    const dims = url.searchParams.get('dimensions');
    const metrics = url.searchParams.get('metrics').split(',');
    if (dims === 'insightTrafficSourceType') return json({ columnHeaders: [{ name: dims }, ...metrics.map((name) => ({ name }))], rows: [['YT_SEARCH', 30, 1], ['RELATED_VIDEO', 70, 2]] });
    if (dims === 'video') return json({ columnHeaders: [{ name: 'video' }, ...metrics.map((name) => ({ name }))], rows: [['vid00000001', 9, 9, 9, 9, 9]] });
    if (dims === 'country') return json({ error: { message: 'boom' } }, 400);
    return json({ columnHeaders: metrics.map((name) => ({ name })), rows: [metrics.map(() => 1)] });
  };
  const ca = new ChannelAnalytics({ oauth: { getAccessToken: async () => 'TOKEN', grantedScopes: async () => [] }, fetchImpl, now: () => Date.parse('2026-11-24T00:00:00Z') });
  const o = await ca.overview(28);
  assert.equal(o.range.endDate, '2026-11-23');
  assert.equal(o.range.startDate, '2026-10-27');
  assert.ok(seen.filter((u) => u.hostname === 'youtubeanalytics.googleapis.com').every((u) => u.searchParams.get('ids') === 'channel==MINE'));
  assert.equal(o.traffic[0].label, 'Suggested videos');
  assert.equal(o.traffic[0].share, 0.7);
  assert.equal(o.topVideos[0].title, 'My video');
  assert.equal(o.errors.geography, 'boom', 'one failing report does not break the rest');
  assert.equal(o.revenue, undefined, 'revenue not requested without the monetary scope');
  const terms = seen.find((u) => u.searchParams.get('dimensions') === 'insightTrafficSourceDetail');
  assert.equal(terms.searchParams.get('filters'), 'insightTrafficSourceType==YT_SEARCH');
  assert.equal(terms.searchParams.get('maxResults'), '25');

  const noAuth = new ChannelAnalytics({ oauth: { getAccessToken: async () => null, grantedScopes: async () => [] }, fetchImpl });
  await assert.rejects(noAuth.myChannel(), (e) => e.status === 401);
  await assert.rejects(ca.retention('bad id'), /Invalid video ID/);
});
