// Cross-feature wiring: the real feature modules (src/features/index.js) on one shared ctx, the way
// server.js builds them, with a fake YouTube client, a fake clock and a temp JsonStore.
//   (a) Rankings check -> 'ranks' event -> Alerts feed
//   (b) Tracker snapshot -> 'snapshot' event -> Alerts (new upload, breakout, milestone), no duplicates
//   (c) GET /api/video returns every field the Chrome extension reads
//   plus a smoke test of server.js itself (spawned in demo mode)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { FEATURES } from '../src/features/index.js';
import { JsonStore } from '../src/store.js';
import { Tracker } from '../src/tracker.js';
import { DemoClient } from '../src/demo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-01T09:00:00Z');
const MINE = 'UCe2emine000000000000000';
const OTHER = 'UCe2eother00000000000000';

const iso = (t) => new Date(t).toISOString();

/** A videos.list-shaped item. */
function rawVideo({ id, title, publishedAt, views, likes = Math.round(views * 0.04), comments = Math.round(views * 0.004), duration = 'PT10M5S', channelId = MINE, tags = ['desk setup', 'budget desk'], description }) {
  return {
    id,
    snippet: {
      channelId, channelTitle: channelId === MINE ? 'E2E Channel' : 'Someone Else', title, publishedAt,
      description: description ?? `${title}. A walkthrough of a budget desk setup.\n\n0:00 Intro\n1:10 Desk\n4:30 Lighting`,
      tags, thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } },
    },
    statistics: { viewCount: String(views), likeCount: String(likes), commentCount: String(comments) },
    contentDetails: { duration },
  };
}

/** Search hits as search.list + videos.list return them: `mine` = 1-based positions held by MINE. */
const serp = (mine = [], n = 50) => Array.from({ length: n }, (_, i) => rawVideo({
  id: `s${String(i + 1).padStart(10, '0')}`, title: `Result ${i + 1}`, publishedAt: iso(T0 - 30 * DAY), views: 1000,
  channelId: mine.includes(i + 1) ? MINE : OTHER,
}));

/**
 * DemoClient with one controllable channel (MINE): its statistics, uploads and the search results are
 * set by the test. Everything else falls through to the synthetic demo data.
 */
class FakeClient extends DemoClient {
  constructor() {
    super({ now: T0 });
    this.subs = 9_800;
    this.uploads = [];
    this.searchResults = serp();
  }

  async resolveChannelId(input) { return input === '@e2e' ? MINE : super.resolveChannelId(input); }

  async getChannels(ids) {
    const mine = ids.includes(MINE) ? [{
      id: MINE,
      snippet: { title: 'E2E Channel', customUrl: '@e2e', thumbnails: { default: { url: 'https://yt3.ggpht.com/e2e' } }, description: 'Desk setups.' },
      statistics: { subscriberCount: String(this.subs), viewCount: '5000000', videoCount: String(this.uploads.length), hiddenSubscriberCount: false },
      contentDetails: { relatedPlaylists: { uploads: 'UUe2emine000000000000000' } },
    }] : [];
    return [...mine, ...(await super.getChannels(ids.filter((id) => id !== MINE)))];
  }

  async getUploads(channel, max = 50) {
    if (channel.id !== MINE) return super.getUploads(channel, max);
    return { videos: this.uploads.slice(0, max), complete: this.uploads.length <= max };
  }

  async getVideos(ids) {
    const mine = new Map(this.uploads.map((v) => [v.id, v]));
    return Promise.all(ids.map(async (id) => mine.get(id) || (await super.getVideos([id]))[0]));
  }

  async searchVideos() {
    this.searchCalls += 1;
    return this.searchResults;
  }
}

/** Everything server.js wires up, minus HTTP: ctx, route table, tracker -> events. */
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tubescout-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { t: T0, now: () => clock.t, advance: (ms) => { clock.t += ms; } };
  const client = new FakeClient();
  const store = new JsonStore(dir);
  const events = new EventEmitter();
  const tracker = new Tracker({ client, store, now: clock.now, onSnapshot: (e) => { events.emit('snapshot', e); } });
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const ctx = {
    env: { DISABLE_SCHEDULER: '1' }, DEMO: false, client, store, tracker, oauth: { configured: false }, channelAnalytics: null, events,
    meta: () => ({ mode: 'live', quotaUsedSinceStart: client.quotaUsed, searchCallsSinceStart: client.searchCalls }),
    // Same contract as server.js readJson: tests pass the parsed body on req.body.
    readJson: async (req) => req.body ?? {},
    httpError,
    intParam: (v, def, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; },
    regionParam: (v) => (/^[A-Za-z]{2}$/.test(v || '') ? v.toUpperCase() : undefined),
    log: () => {},
  };
  const routes = {};
  for (const create of FEATURES) {
    // The second argument is each module's test hook; only Rankings reads `now` (fake clock).
    const f = await create(ctx, { now: clock.now });
    for (const [key, handler] of Object.entries(f.routes || {})) {
      assert.ok(!routes[key], `duplicate route ${key}`);
      routes[key] = handler;
    }
  }
  const call = async (key, { query = {}, body } = {}) => {
    const handler = routes[key];
    assert.ok(handler, `route ${key} exists`);
    const url = new URL(`http://localhost${key.split(' ')[1]}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return handler(url, { body });
  };
  // Alerts process events asynchronously (serialized queue): poll the feed.
  const alertsWhere = async (pred, label) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const d = await call('GET /api/alerts', { query: { limit: '500' } });
      if (pred(d.alerts)) return d.alerts;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}; feed: ${JSON.stringify(d.alerts.map((a) => a.type))}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 150)); // let any (unwanted) extra alert land
  return { client, clock, tracker, events, call, alertsWhere, settle };
}

test('feature registry: every module builds on one ctx and the routes do not collide', async (t) => {
  const { call } = await setup(t);
  for (const key of ['GET /api/alerts', 'GET /api/ranks', 'GET /api/video', 'GET /api/audit/channel', 'GET /api/ai/status']) {
    assert.ok(await call(key, { query: key === 'GET /api/video' ? { id: 'dQw4w9WgXcQ' } : key.includes('audit') ? { q: '@e2e' } : {} }), key);
  }
});

test('(a) Rankings check twice -> a rank alert in the Alerts feed', async (t) => {
  const { client, clock, call, alertsWhere, settle } = await setup(t);
  // Delivery channels are not configured (env has none), so nothing leaves the process.
  client.searchResults = serp([12]);
  const added = await call('POST /api/ranks', { body: { keyword: 'budget desk setup', channel: '@e2e' } });
  assert.equal(added.checkError, null);
  assert.equal(added.item.position, 12);
  await settle();
  assert.equal((await call('GET /api/alerts')).total, 0, 'the first check has nothing to compare with');

  clock.advance(DAY);
  client.searchResults = serp([3, 20]);
  const checked = await call('POST /api/ranks/check', { body: { id: added.item.id } });
  assert.equal(checked.checked, true);
  assert.equal(checked.item.position, 3);

  const [alert] = await alertsWhere((list) => list.length === 1, 'rank alert');
  assert.equal(alert.type, 'rank');
  assert.match(alert.title, /^Entered the top 10 for “budget desk setup”/);
  assert.match(alert.message, /E2E Channel is now #3 in YouTube search \(was #12\)/);
  assert.equal(alert.channelId, MINE);
  assert.equal(alert.url, `https://www.youtube.com/watch?v=${serp()[2].id}`);
  assert.equal(client.searchCalls, 2);

  // The same position on the next day is not news.
  clock.advance(DAY);
  await call('POST /api/ranks/check', { body: { id: added.item.id } });
  await settle();
  assert.equal((await call('GET /api/alerts')).total, 1);
});

test('(b) tracker snapshots -> new upload, breakout and milestone alerts, no duplicates on a repeat', async (t) => {
  const { client, clock, tracker, events, call, alertsWhere, settle } = await setup(t);
  // Ten established long videos (2-10 weeks old) with steady views, and the channel just under 10K subs.
  client.uploads = Array.from({ length: 10 }, (_, i) => rawVideo({
    id: `old${String(i).padStart(8, '0')}`, title: `Desk setup tour ${i + 1}`, publishedAt: iso(T0 - (14 + 7 * i) * DAY), views: 20_000 + 1000 * i,
  }));
  let payload = null;
  events.on('snapshot', (p) => { payload = p; });

  await call('GET /api/alerts'); // (feature already listening)
  const { added } = await tracker.add('@e2e');
  assert.equal(added, true);
  await settle();
  assert.equal((await call('GET /api/alerts')).total, 0, 'the first snapshot never alerts');

  // 13 hours later: one new upload, one old video taking off, and the channel passed 10K subscribers.
  clock.advance(13 * HOUR);
  client.subs = 10_200;
  const fresh = rawVideo({ id: 'newvid00001', title: 'My new desk build', publishedAt: iso(clock.t - 2 * HOUR), views: 900 });
  client.uploads = [fresh, ...client.uploads.map((v, i) => (i === 3
    ? { ...v, statistics: { ...v.statistics, viewCount: String(Number(v.statistics.viewCount) + 30_000) } } // ~55K/day
    : { ...v, statistics: { ...v.statistics, viewCount: String(Number(v.statistics.viewCount) + 100) } }))];
  const results = await tracker.runDue({ force: true });
  assert.deepEqual(results, [{ id: MINE, ok: true }]);

  const list = await alertsWhere((l) => l.length >= 3, 'three snapshot alerts');
  await settle();
  const feed = (await call('GET /api/alerts')).alerts;
  assert.deepEqual(feed.map((a) => a.type).sort(), ['breakout', 'milestone', 'upload'], JSON.stringify(list.map((a) => a.title)));
  const byType = Object.fromEntries(feed.map((a) => [a.type, a]));
  assert.equal(byType.upload.title, 'New video from E2E Channel');
  assert.equal(byType.upload.videoId, 'newvid00001');
  assert.equal(byType.breakout.videoId, client.uploads[4].id);
  assert.match(byType.breakout.message, /gained ~\S+ views\/day over the last 13 hours/);
  assert.equal(byType.milestone.title, 'E2E Channel passed 10K subscribers');
  for (const a of feed) assert.equal(a.channelId, MINE);

  // Repeat: the same event replayed (e.g. a listener re-fired) creates nothing new...
  events.emit('snapshot', payload);
  await settle();
  assert.equal((await call('GET /api/alerts')).total, 3);

  // ...and neither does the next snapshot, 13h later, while the breakout continues (7-day cooldown),
  // the "new" upload is now known and subscribers stay above 10K.
  clock.advance(13 * HOUR);
  client.uploads = client.uploads.map((v, i) => (i === 4
    ? { ...v, statistics: { ...v.statistics, viewCount: String(Number(v.statistics.viewCount) + 30_000) } }
    : v));
  await tracker.runDue({ force: true });
  await settle();
  assert.equal((await call('GET /api/alerts')).total, 3);
});

test('server.js boots with every feature, logs all integrations and serves the wiring the extension needs', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tubescout-e2e-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  // server.js also loads the repo's .env, but only for variables that are unset here. So pin everything
  // the test depends on: DEMO=1 forces the synthetic client even if .env has a YouTube key (nothing here
  // calls out), and HOST + a test APP_PASSWORD keep a hosted setup's .env from turning requests into 401s.
  const password = 'e2e-test-password';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', APP_PASSWORD: password, DATA_DIR: dir, DISABLE_SCHEDULER: '1', DEMO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10_000);
    const onData = (b) => { out += b; if (/Integrations: .*\n/.test(out)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
  });
  assert.match(out, /Integrations: Google Trends \w+ · Keyword volume \w+ · My channel login \w+ · AI Studio \w+ · Alert delivery /);

  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Basic ${Buffer.from(`any:${password}`).toString('base64')}` };
  assert.equal((await fetch(`${base}/api/status`)).status, 401, 'APP_PASSWORD is enforced');
  const status = await (await fetch(`${base}/api/status`, { headers: auth })).json();
  assert.equal(status.mode, 'demo');
  assert.deepEqual(Object.keys(status.integrations).sort(), ['ai', 'alerts', 'oauth', 'trends', 'volume']);
  assert.equal(status.capabilities.demandLite, true, 'the extension relies on this to load keyword data automatically');
  for (const p of ['/api/alerts', '/api/ranks', '/api/ai/status', '/api/tracked']) assert.equal((await fetch(base + p, { headers: auth })).status, 200, p);
  // Feature POST routes go through the core readJson (JSON content type required: CSRF guard).
  const r = await fetch(`${base}/api/alerts/read`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{"all":true}' });
  assert.equal(r.status, 415);
});

/** The extension's lib.js is a classic browser script: run it in a vm context like test/extension.test.js does. */
async function loadExtensionLib() {
  const ctx = vm.createContext({ URL, URLSearchParams, TextEncoder, btoa });
  vm.runInContext(await readFile(path.join(ROOT, 'extension', 'lib.js'), 'utf8'), ctx, { filename: 'lib.js' });
  return ctx.TubeScoutLib;
}

test('(c) GET /api/video has every field the Chrome extension reads', async (t) => {
  const { client, call } = await setup(t);
  client.uploads = Array.from({ length: 8 }, (_, i) => rawVideo({
    id: `vid${String(i).padStart(8, '0')}`, title: `Budget desk setup ${i + 1}`, publishedAt: iso(Date.now() - (10 + 5 * i) * DAY), views: 10_000 + 2000 * i,
  }));
  const target = client.uploads[0];
  const d = await call('GET /api/video', { query: { id: `https://www.youtube.com/watch?v=${target.id}`, keyword: 'budget desk' } });

  // extension/content.js videoView(): d.video, d.channel, d.seo, d.outlierScore, d.meta.mode
  const v = d.video;
  for (const [key, type] of Object.entries({
    id: 'string', title: 'string', channelId: 'string', views: 'number', viewsPerDay: 'number', ageDays: 'number',
    isShort: 'boolean', engagementRate: 'number',
  })) assert.equal(typeof v[key], type, `video.${key}`);
  assert.equal(v.id, target.id);
  assert.equal(v.channelId, MINE);
  assert.ok(Array.isArray(v.tags) && v.tags.every((x) => typeof x === 'string'), 'video.tags');
  assert.equal(typeof d.channel.avgEngagement, 'number', 'channel.avgEngagement');
  assert.equal(typeof d.outlierScore, 'number', 'outlierScore');
  assert.ok(d.outlierScore > 0);
  assert.equal(d.meta.mode, 'live');

  assert.ok(Number.isInteger(d.seo.score) && d.seo.score >= 0 && d.seo.score <= 100, 'seo.score');
  assert.match(d.seo.grade, /^[A-F]$/);
  assert.ok(Array.isArray(d.seo.checks) && d.seo.checks.length > 0, 'seo.checks');
  for (const c of d.seo.checks) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.label, 'string');
    assert.ok(['rule', 'heuristic'].includes(c.kind), `${c.id} kind`);
    assert.equal(typeof c.passed, 'boolean');
    assert.equal(typeof c.points, 'number');
    assert.equal(typeof c.maxPoints, 'number');
    assert.ok(typeof c.fix === 'string' || typeof c.detail === 'string', `${c.id} has fix or detail`);
  }
  // The keyword was used for scoring (the extension's "Re-score" sends it).
  assert.ok(d.seo.checks.some((c) => c.id === 'keyword-title'));

  // The extension's own helper picks failed checks from this exact shape.
  const L = await loadExtensionLib();
  const failed = L.topFailedChecks(d.seo.checks, 3);
  assert.ok(failed.length <= 3);
  for (const c of failed) assert.equal(c.passed, false);
  const worst = d.seo.checks.filter((c) => c.passed === false && !c.info && c.maxPoints > 0);
  assert.equal(failed.length, Math.min(3, worst.length));

  // Every endpoint the extension's worker is allowed to call exists on the server (feature or core route).
  const core = ['GET /api/status', 'GET /api/channel', 'GET /api/demand', 'POST /api/tracked'];
  const server = await readFile(path.join(ROOT, 'server.js'), 'utf8');
  for (const key of core) assert.ok(server.includes(`'${key}'`), `server.js defines ${key}`);
  const lib = await readFile(path.join(ROOT, 'extension', 'lib.js'), 'utf8');
  for (const key of ['GET /api/video', ...core]) assert.ok(lib.includes(`'${key}'`), `extension allowlist has ${key}`);
});
