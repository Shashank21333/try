import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  findPositions, topResults, rankChange, rankReport, checksInWindow, itemId, isItemId, normalizeKeyword,
  RankTracker, MAX_ITEMS, MAX_HISTORY, DUE_AFTER_MS,
} from '../src/ranks.js';
import { create } from '../src/features/ranks.js';
import { JsonStore } from '../src/store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-01T09:00:00Z');
const ME = 'UCmine00000000000000000a';
const OTHER = 'UCother0000000000000000b';

const vid = (id, channelId, title = `Video ${id}`, channelTitle = channelId === ME ? 'My Channel' : 'Someone Else') => ({ id, snippet: { channelId, channelTitle, title } });
/** 50 results; `mine` lists the 1-based positions held by ME. */
const results = (mine = [], n = 50) => Array.from({ length: n }, (_, i) => vid(`v${i + 1}`, mine.includes(i + 1) ? ME : OTHER));

async function tempStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ranks-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new JsonStore(dir);
}

/** Fake YouTube client: `serp` maps keyword -> results (or a function of call count). */
function fakeClient(serp = {}) {
  return {
    searches: [],
    async resolveChannelId(input) {
      if (input === '@missing') throw Object.assign(new Error('No channel found for @missing'), { status: 404 });
      return input === '@mine' ? ME : OTHER;
    },
    async getChannels(ids) { return ids.map((id) => ({ id, snippet: { title: id === ME ? 'My Channel' : 'Other Channel' } })); },
    async searchVideos(q, opts) {
      this.searches.push({ q, ...opts });
      const r = serp[q];
      return typeof r === 'function' ? r(this.searches.length) : r || results();
    },
  };
}

const clock = (start = T0) => { const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; };

// ---------------------------------------------------------------- pure logic

test('findPositions: first match, all positions, video id and title', () => {
  const r = findPositions(results([4, 12, 50]), ME);
  assert.deepEqual(r, { position: 4, positions: [4, 12, 50], videoId: 'v4', title: 'Video v4' });
  assert.equal(findPositions(results([1]), ME).position, 1);
});

test('findPositions: not in the results -> null', () => {
  assert.deepEqual(findPositions(results([]), ME), { position: null, positions: [], videoId: null, title: null });
  assert.deepEqual(findPositions([], ME), { position: null, positions: [], videoId: null, title: null });
  assert.deepEqual(findPositions(undefined, ME), { position: null, positions: [], videoId: null, title: null });
  // Items without a snippet are skipped but still occupy their rank.
  assert.equal(findPositions([{ id: 'x' }, vid('y', ME)], ME).position, 2);
});

test('topResults keeps only channel and title of the top 3', () => {
  assert.deepEqual(topResults(results([2])), [
    { channelTitle: 'Someone Else', title: 'Video v1' },
    { channelTitle: 'My Channel', title: 'Video v2' },
    { channelTitle: 'Someone Else', title: 'Video v3' },
  ]);
  assert.deepEqual(topResults([]), []);
});

test('rankChange: lower number is better', () => {
  const at = (position, t = 0) => ({ position, t });
  assert.deepEqual(rankChange(at(10, 5), at(4)), { from: 10, to: 4, since: 5, places: 6, dir: 'up' });
  assert.deepEqual(rankChange(at(4), at(9)), { from: 4, to: 9, since: 0, places: -5, dir: 'down' });
  assert.equal(rankChange(at(3), at(3)).dir, 'same');
  assert.deepEqual(rankChange(at(null), at(7)), { from: null, to: 7, since: 0, places: null, dir: 'entered' });
  assert.deepEqual(rankChange(at(7), at(null)), { from: 7, to: null, since: 0, places: null, dir: 'dropped' });
  assert.equal(rankChange(at(null), at(null)).dir, 'same');
  assert.equal(rankChange(null, at(1)), null);
  assert.equal(rankChange(at(1), null), null);
});

test('ids are stable, case-insensitive on keyword and safe as store keys', () => {
  const a = itemId('Best  Budget Phone ', 'US', ME);
  assert.equal(a, itemId('best budget phone', 'US', ME));
  assert.notEqual(a, itemId('best budget phone', null, ME));
  assert.notEqual(a, itemId('best budget phone', 'US', OTHER));
  assert.ok(isItemId(a) && /^[\w.-]+$/.test(`rank-${a}`));
  assert.ok(!isItemId('../etc') && !isItemId('') && !isItemId(undefined));
  assert.equal(normalizeKeyword('  a \n b  '), 'a b');
  assert.equal(normalizeKeyword(42), '');
});

test('rankReport: deltas vs previous and ~7 days ago, best, days tracked (fake clock)', () => {
  const item = { id: 'abc', keyword: 'kw', region: null, channelId: ME, channelTitle: 'My Channel', addedAt: 'x' };
  // Daily checks on days 0..10 (with a 2h jitter on day 3) -> positions below.
  const positions = [20, 18, null, 15, 12, 11, 9, 10, 8, 6, 7];
  const hist = positions.map((p, d) => ({ t: T0 + d * DAY + (d === 3 ? 2 * HOUR : 0), position: p, positions: p ? [p] : [], videoId: p ? `v${p}` : null, title: null, resultCount: 50, top3: [] }));
  const now = T0 + 10 * DAY + 3 * HOUR;
  const r = rankReport(item, hist, now);
  assert.equal(r.position, 7);
  assert.equal(r.checks, 11);
  assert.equal(r.lastChecked, T0 + 10 * DAY);
  assert.deepEqual(r.change, { from: 6, to: 7, since: T0 + 9 * DAY, places: -1, dir: 'down' });
  // Latest is day 10; nearest check at least 6.5 days older is day 3 (day 3 + 2h is still >= 6.5d before).
  assert.deepEqual(r.change7d, { from: 15, to: 7, since: T0 + 3 * DAY + 2 * HOUR, places: 8, dir: 'up' });
  assert.deepEqual(r.best, { position: 6, t: T0 + 9 * DAY });
  assert.equal(r.daysTracked, 10);
  assert.equal(r.firstChecked, T0);
  assert.equal(r.due, false);
  assert.equal(r.series.length, 11);
  assert.deepEqual(r.series[2], { t: T0 + 2 * DAY, position: null });

  // Only 5 days of history: no 7-day comparison yet.
  const short = rankReport(item, hist.slice(0, 6), T0 + 5 * DAY);
  assert.equal(short.change7d, null);
  assert.deepEqual(short.change.dir, 'up');

  // A check 6.4 days older is not old enough; 6.5 days is.
  const pair = (gap) => [{ t: T0, position: 5 }, { t: T0 + gap, position: 3 }];
  assert.equal(rankReport(item, pair(6.4 * DAY), T0 + 7 * DAY).change7d, null);
  assert.equal(rankReport(item, pair(6.5 * DAY), T0 + 7 * DAY).change7d.places, 2);

  // Due once the last check is older than 20h.
  assert.equal(rankReport(item, hist, T0 + 10 * DAY + DUE_AFTER_MS).due, true);
});

test('rankReport: never checked and never found', () => {
  const item = { id: 'abc', keyword: 'kw', region: 'US', channelId: ME, channelTitle: 'Me', addedAt: 'x' };
  const empty = rankReport(item, [], T0);
  assert.equal(empty.position, null);
  assert.equal(empty.change, null);
  assert.equal(empty.best, null);
  assert.equal(empty.due, true);
  assert.equal(empty.daysTracked, 0);
  const missing = rankReport(item, [{ t: T0, position: null, positions: [] }, { t: T0 + DAY, position: null, positions: [] }], T0 + DAY);
  assert.equal(missing.best, null);
  assert.equal(missing.change.dir, 'same');
  assert.equal(missing.region, 'US');
});

test('checksInWindow is a rolling 24h window', () => {
  assert.deepEqual(checksInWindow([T0 - DAY, T0 - DAY + 1, T0 - 1, T0, T0 + 1, 'x'], T0), [T0 - DAY + 1, T0 - 1, T0]);
  assert.deepEqual(checksInWindow(null, T0), []);
});

// ---------------------------------------------------------------- RankTracker

test('quota guard: rolling 24h cap, persisted in the store', async (t) => {
  const store = await tempStore(t);
  const c = clock();
  const client = fakeClient();
  const rt = new RankTracker({ client, store, maxChecksPerDay: 3, now: c.now });
  const item = await rt.add({ keyword: 'kw', channel: { id: ME, title: 'Me' } });

  await rt.check(item); c.advance(HOUR);
  await rt.check(item); c.advance(HOUR);
  await rt.check(item);
  assert.deepEqual(await rt.quota(), { checksLast24h: 3, maxChecksPerDay: 3, nextSlotAt: T0 + DAY });
  await assert.rejects(rt.check(item), (e) => e.status === 429 && /3 of 3 checks/.test(e.message) && /about 22 h/.test(e.message));
  assert.equal(client.searches.length, 3, 'refused checks must not call the API');

  // A new tracker on the same store sees the same budget (survives restarts).
  const rt2 = new RankTracker({ client, store, maxChecksPerDay: 3, now: c.now });
  await assert.rejects(rt2.check(item), { status: 429 });

  // The first check leaves the window 24h later -> exactly one slot frees up.
  c.t = T0 + DAY + 1;
  await rt.check(item);
  await assert.rejects(rt.check(item), { status: 429 });
  assert.equal((await rt.quota()).checksLast24h, 3);
  assert.equal((await rt.history(item.id)).length, 4);

  const off = new RankTracker({ client, store, maxChecksPerDay: 0, now: c.now });
  await assert.rejects(off.check(item), /disabled/);
});

test("'ranks' event payload after every check", async (t) => {
  const store = await tempStore(t);
  const c = clock();
  const events = new EventEmitter();
  const seen = [];
  events.on('ranks', (e) => seen.push(e));
  let call = 0;
  const client = fakeClient({ 'budget phone': () => (++call === 1 ? results([9, 30]) : results([])) });
  const rt = new RankTracker({ client, store, events, now: c.now });
  const item = await rt.add({ keyword: 'budget phone', region: 'GB', channel: { id: ME, title: 'My Channel' } });

  await rt.check(item);
  c.advance(DAY);
  await rt.check(item);
  assert.deepEqual(seen, [
    {
      itemId: item.id, keyword: 'budget phone', region: 'GB', channelId: ME, channelTitle: 'My Channel',
      previous: { position: null, t: null },
      current: { position: 9, videoId: 'v9', title: 'Video v9', t: T0 },
    },
    {
      itemId: item.id, keyword: 'budget phone', region: 'GB', channelId: ME, channelTitle: 'My Channel',
      previous: { position: 9, t: T0 },
      current: { position: null, videoId: null, title: null, t: T0 + DAY },
    },
  ]);
  assert.deepEqual(client.searches[0], { q: 'budget phone', max: 50, regionCode: 'GB' });

  // A throwing listener does not fail the check.
  const logs = [];
  events.on('ranks', () => { throw new Error('boom'); });
  rt.log = (m) => logs.push(m);
  c.advance(DAY);
  assert.ok(await rt.check(item));
  assert.match(logs[0], /boom/);
});

test('history keeps the last MAX_HISTORY checks; add enforces duplicates and MAX_ITEMS', async (t) => {
  const store = await tempStore(t);
  const rt = new RankTracker({ client: fakeClient(), store, maxChecksPerDay: 1000 });
  const item = await rt.add({ keyword: 'kw', channel: { id: ME, title: 'Me' } });
  await store.write(`rank-${item.id}`, Array.from({ length: MAX_HISTORY }, (_, i) => ({ t: i, position: 1 })));
  await rt.check(item);
  const hist = await rt.history(item.id);
  assert.equal(hist.length, MAX_HISTORY);
  assert.equal(hist[0].t, 1);

  await assert.rejects(rt.add({ keyword: 'KW ', channel: { id: ME, title: 'Me' } }), { status: 409 });
  for (let i = 1; i < MAX_ITEMS; i++) await rt.add({ keyword: `kw ${i}`, channel: { id: ME, title: 'Me' } });
  await assert.rejects(rt.add({ keyword: 'one too many', channel: { id: ME, title: 'Me' } }), { status: 400 });

  assert.equal(await rt.remove(item.id), true);
  assert.deepEqual(await rt.history(item.id), []);
  assert.equal(await rt.remove(item.id), false);
});

test('runDue checks only items older than 20h, oldest first, and stops at the daily cap', async (t) => {
  const store = await tempStore(t);
  const c = clock();
  const client = fakeClient();
  const rt = new RankTracker({ client, store, maxChecksPerDay: 3, now: c.now });
  const a = await rt.add({ keyword: 'a', channel: { id: ME, title: 'Me' } });
  const b = await rt.add({ keyword: 'b', channel: { id: ME, title: 'Me' } });
  const cc = await rt.add({ keyword: 'c', channel: { id: ME, title: 'Me' } });
  const d = await rt.add({ keyword: 'd', channel: { id: ME, title: 'Me' } });
  // History: a checked 21h ago, b 18h ago, c 30h ago, d never.
  await store.write(`rank-${a.id}`, [{ t: T0 - 21 * HOUR, position: 1 }]);
  await store.write(`rank-${b.id}`, [{ t: T0 - 18 * HOUR, position: 1 }]);
  await store.write(`rank-${cc.id}`, [{ t: T0 - 30 * HOUR, position: 1 }]);

  const run = await rt.runDue();
  assert.equal(run.due, 3);
  assert.deepEqual(client.searches.map((s) => s.q), ['d', 'c', 'a']);
  assert.deepEqual(run.results.map((r) => r.id), [d.id, cc.id, a.id]);

  // Nothing is due an hour later (b is 19h old).
  c.advance(HOUR);
  assert.deepEqual(await rt.runDue(), { due: 0, results: [] });

  // b becomes due, but the 3-check budget is used up: one 429 result, then stop.
  c.advance(2 * HOUR);
  const capped = await rt.runDue();
  assert.equal(capped.due, 1);
  assert.equal(capped.results[0].status, 429);
  assert.equal(client.searches.length, 3);

  // Concurrent calls share one run.
  assert.equal(rt.runDue(), rt.runDue());
  await rt.runDue();
});

test('runDue keeps going after a non-quota API error but stops on quotaExceeded', async (t) => {
  const store = await tempStore(t);
  const client = fakeClient({
    a: () => { throw Object.assign(new Error('Backend error'), { status: 503 }); },
    b: () => { throw Object.assign(new Error('YouTube API daily quota exceeded.'), { status: 403, reason: 'quotaExceeded' }); },
  });
  const rt = new RankTracker({ client, store, now: () => T0, log: () => {} });
  for (const k of ['a', 'b', 'c']) await rt.add({ keyword: k, channel: { id: ME, title: 'Me' } });
  const run = await rt.runDue();
  assert.deepEqual(run.results.map((r) => r.status), [503, 403]);
  assert.deepEqual(client.searches.map((s) => s.q), ['a', 'b']);
});

test('start() runs due checks on an unref\'d hourly timer', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const rt = new RankTracker({ client: fakeClient(), store: { read: async (k, f) => f } });
  let runs = 0;
  rt.runDue = async () => { runs++; return { due: 0, results: [] }; };
  rt.start();
  mock.timers.tick(30_000);
  assert.equal(runs, 1, 'first run shortly after start');
  mock.timers.tick(HOUR - 30_000);
  assert.equal(runs, 2);
  mock.timers.tick(HOUR);
  assert.equal(runs, 3);
  rt.stop();
  mock.timers.tick(5 * HOUR);
  assert.equal(runs, 3);
});

// ---------------------------------------------------------------- routes

async function setup(t, { env = {}, serp } = {}) {
  const store = await tempStore(t);
  const c = clock();
  const client = fakeClient(serp);
  const events = new EventEmitter();
  const seen = [];
  events.on('ranks', (e) => seen.push(e));
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const ctx = {
    env: { DISABLE_SCHEDULER: '1', ...env }, DEMO: false, client, store, events, httpError,
    meta: () => ({ mode: 'live' }),
    readJson: async (req) => req.body,
    intParam: (v, def, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; },
    regionParam: (v) => (/^[A-Za-z]{2}$/.test(v || '') ? v.toUpperCase() : undefined),
    log: () => {},
  };
  const f = create(ctx, { now: c.now });
  const call = (key, body) => f.routes[key](new URL('http://localhost/api/ranks'), { body });
  return { f, call, c, client, store, seen };
}

test('POST /api/ranks validates input', async (t) => {
  const { call, client } = await setup(t);
  const bad = async (body, re, status = 400) => assert.rejects(call('POST /api/ranks', body), (e) => e.status === status && re.test(e.message));
  await bad({ channel: '@mine' }, /keyword/);
  await bad({ keyword: '   ', channel: '@mine' }, /keyword/);
  await bad({ keyword: 'x'.repeat(101), channel: '@mine' }, /100 characters/);
  await bad({ keyword: 'kw' }, /channel/);
  await bad({ keyword: 'kw', channel: 42 }, /channel/);
  await bad({ keyword: 'kw', channel: '@mine', region: 'USA' }, /2-letter/);
  await bad({ keyword: 'kw', channel: '@missing' }, /No channel/, 404);
  assert.equal(client.searches.length, 0);
});

test('POST /api/ranks adds, runs the first check and GET reports it', async (t) => {
  const { call, c, seen } = await setup(t, { serp: { 'budget phone': results([5, 20]) } });
  const res = await call('POST /api/ranks', { keyword: ' budget  phone ', channel: '@mine', region: 'us' });
  assert.equal(res.added, true);
  assert.equal(res.checkError, null);
  assert.equal(res.item.keyword, 'budget phone');
  assert.equal(res.item.region, 'US');
  assert.equal(res.item.channelTitle, 'My Channel');
  assert.equal(res.item.position, 5);
  assert.deepEqual(res.item.positions, [5, 20]);
  assert.equal(res.checksLast24h, 1);
  assert.equal(res.maxChecksPerDay, 20);
  assert.equal(seen.length, 1);

  await assert.rejects(call('POST /api/ranks', { keyword: 'Budget Phone', channel: '@mine', region: 'US' }), { status: 409 });

  c.advance(HOUR);
  const list = await call('GET /api/ranks');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].position, 5);
  assert.equal(list.autoChecks, false);
  assert.deepEqual(list.meta, { mode: 'live' });
  assert.equal(list.checksLast24h, 1);
});

test('POST /api/ranks/check: single item, recent-check short-circuit, check all, quota 429', async (t) => {
  const { call, c, client } = await setup(t, { env: { RANK_MAX_CHECKS_PER_DAY: '3' } });
  const { item } = await call('POST /api/ranks', { keyword: 'kw', channel: '@mine' });
  assert.equal(item.position, null, 'not in top 50');

  // Checked 5 minutes ago -> no new search, no budget used.
  c.advance(5 * 60_000);
  const soon = await call('POST /api/ranks/check', { id: item.id });
  assert.equal(soon.checked, false);
  assert.match(soon.message, /5 min ago/);
  assert.equal(client.searches.length, 1);

  c.advance(HOUR);
  const now = await call('POST /api/ranks/check', { id: item.id });
  assert.equal(now.checked, true);
  assert.equal(now.item.checks, 2);
  assert.equal(now.checksLast24h, 2);

  // Check all: nothing due yet.
  const none = await call('POST /api/ranks/check', {});
  assert.equal(none.due, 0);

  // A day later the item is due; the 3rd check uses the last slot.
  c.advance(DAY - 2 * HOUR);
  const all = await call('POST /api/ranks/check', {});
  assert.equal(all.due, 1);
  assert.equal(all.results.length, 1);
  assert.equal(all.checksLast24h, 3);

  // Budget exhausted (3 checks within 24h): a single check is refused with 429.
  c.advance(20 * 60_000);
  await assert.rejects(call('POST /api/ranks/check', { id: item.id }), (e) => e.status === 429 && /3 of 3/.test(e.message));
  // Adding still works; the first check is deferred with an explanation.
  const added = await call('POST /api/ranks', { keyword: 'another', channel: '@mine' });
  assert.equal(added.added, true);
  assert.match(added.checkError, /limit reached/);
  assert.equal(added.item.checks, 0);
  assert.equal(added.item.due, true);
  // "Check all" with a due item but no budget -> 429.
  await assert.rejects(call('POST /api/ranks/check', {}), { status: 429 });
  assert.equal(client.searches.length, 3);

  await assert.rejects(call('POST /api/ranks/check', { id: 'nope' }), { status: 400 });
  await assert.rejects(call('POST /api/ranks/check', { id: 'abcdefabcdef' }), { status: 404 });
});

test('POST /api/ranks/remove', async (t) => {
  const { call, store } = await setup(t);
  const { item } = await call('POST /api/ranks', { keyword: 'kw', channel: '@mine' });
  assert.equal((await store.read(`rank-${item.id}`, [])).length, 1);
  assert.deepEqual(await call('POST /api/ranks/remove', { id: item.id }), { ok: true });
  assert.deepEqual((await call('GET /api/ranks')).items, []);
  assert.deepEqual(await store.read(`rank-${item.id}`, null), null);
  await assert.rejects(call('POST /api/ranks/remove', { id: item.id }), { status: 404 });
  await assert.rejects(call('POST /api/ranks/remove', { id: '../tracked' }), { status: 400 });
  await assert.rejects(call('POST /api/ranks/remove', {}), { status: 400 });
});
