// Chrome extension (extension/): manifest sanity, the pure helpers in lib.js and
// the service worker's request allowlist. lib.js and background.js are classic
// browser scripts, so they run here in a vm context the way Chrome loads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
// Objects from another vm realm fail deepStrictEqual on prototypes; compare plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

function loadLib() {
  const ctx = vm.createContext({ URL, URLSearchParams, TextEncoder, btoa });
  vm.runInContext(read('lib.js'), ctx, { filename: 'lib.js' });
  return ctx.TubeScoutLib;
}
const L = loadLib();

// ---------- manifest ----------

test('manifest: MV3 with minimal permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['http://localhost/*', 'http://127.0.0.1/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  for (const risky of ['externally_connectable', 'web_accessible_resources', 'content_security_policy']) {
    assert.equal(manifest[risky], undefined, `${risky} should not be declared`);
  }
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.youtube.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, ['lib.js', 'content.js'], 'lib.js must load before content.js');
  assert.ok(/^\d+(\.\d+){0,3}$/.test(manifest.version));
});

test('manifest: every referenced file exists', () => {
  const files = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assert.ok(existsSync(path.join(EXT, f)), `missing ${f}`);
  for (const [size, f] of Object.entries(manifest.icons)) {
    const buf = readFileSync(path.join(EXT, f));
    assert.equal(buf.toString('latin1', 1, 4), 'PNG', `${f} is a PNG`);
    assert.equal(buf.readUInt32BE(16), Number(size), `${f} width`);
    assert.equal(buf.readUInt32BE(20), Number(size), `${f} height`);
  }
  // Scripts and styles referenced by the extension pages, and importScripts in the worker.
  for (const page of [manifest.action.default_popup, manifest.options_ui.page]) {
    const html = read(page);
    const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 2, `${page} references its scripts`);
    for (const r of refs) assert.ok(existsSync(path.join(EXT, r)), `${page} references missing ${r}`);
    assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/, `${page}: inline scripts are blocked by the extension CSP`);
  }
  for (const m of read('background.js').matchAll(/importScripts\('([^']+)'\)/g)) assert.ok(existsSync(path.join(EXT, m[1])));
});

test('extension code never uses HTML sinks, and only the worker calls fetch', () => {
  const scripts = readdirSync(EXT).filter((f) => f.endsWith('.js'));
  assert.ok(scripts.includes('content.js'));
  for (const f of scripts) {
    const src = read(f);
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/, `${f} uses an HTML sink`);
    assert.doesNotMatch(src, /\beval\(|new Function\(/, `${f} evaluates strings`);
    if (f !== 'background.js') assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/, `${f} must go through the service worker`);
  }
  assert.match(read('content.js'), /attachShadow\(\{ mode: 'closed' \}\)/);
});

// ---------- page detection ----------

test('parsePage: watch, shorts and live URLs', () => {
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/watch?v=dQw4w9WgXcQ')), { type: 'video', videoId: 'dQw4w9WgXcQ', isShort: false });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ&t=42s&list=PL123')), { type: 'video', videoId: 'dQw4w9WgXcQ', isShort: false });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/shorts/abcDEF_-123')), { type: 'video', videoId: 'abcDEF_-123', isShort: true });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/live/abcDEF_-123?si=x')), { type: 'video', videoId: 'abcDEF_-123', isShort: false });
  assert.equal(L.parsePage('https://www.youtube.com/watch?v=short').type, null);
  assert.equal(L.parsePage('https://www.youtube.com/watch').type, null);
  assert.equal(L.parsePage('https://www.youtube.com/shorts/').type, null);
  assert.equal(L.parsePage('https://www.youtube.com/watch?v=dQw4w9WgXcQ<script>').type, null);
});

test('parsePage: channel URLs (handle, UC id, legacy user)', () => {
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/@MrBeast')), { type: 'channel', channel: '@MrBeast' });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/@MrBeast/videos')), { type: 'channel', channel: '@MrBeast' });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/@caf%C3%A9.music/shorts')), { type: 'channel', channel: '@café.music' });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/featured')), { type: 'channel', channel: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/user/pewdiepie')), { type: 'channel', channel: 'https://www.youtube.com/user/pewdiepie' });
  assert.equal(L.parsePage('https://www.youtube.com/channel/not-an-id').type, null);
  assert.equal(L.parsePage('https://www.youtube.com/@').type, null);
});

test('parsePage: search results and unsupported pages', () => {
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/results?search_query=how+to+edit+videos')), { type: 'search', query: 'how to edit videos' });
  assert.deepEqual(plain(L.parsePage('https://www.youtube.com/results?search_query=%20budget%20%20mic%20&sp=EgIQAQ')), { type: 'search', query: 'budget mic' });
  assert.equal(L.parsePage('https://www.youtube.com/results?search_query=').type, null);
  for (const u of ['https://www.youtube.com/', 'https://www.youtube.com/feed/subscriptions', 'https://www.youtube.com/playlist?list=PL1',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'not a url', '']) {
    assert.equal(L.parsePage(u).type, null, u);
  }
});

test('pageKey: same video with a different timestamp keeps the key', () => {
  const a = L.pageKey(L.parsePage('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  const b = L.pageKey(L.parsePage('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s'));
  assert.equal(a, 'video:dQw4w9WgXcQ');
  assert.equal(a, b);
  assert.equal(L.pageKey(L.parsePage('https://www.youtube.com/@MrBeast/videos')), L.pageKey(L.parsePage('https://www.youtube.com/@mrbeast')));
  assert.equal(L.pageKey({ type: null }), '');
});

// ---------- server URL, permissions, auth ----------

test('normalizeServerUrl / originPattern / isBuiltinHost', () => {
  assert.equal(L.normalizeServerUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(L.normalizeServerUrl(' http://localhost:3000/ '), 'http://localhost:3000');
  assert.equal(L.normalizeServerUrl('http://127.0.0.1:3000/#tab=keyword'), 'http://127.0.0.1:3000');
  assert.equal(L.normalizeServerUrl('https://scout.example.com/some/path'), 'https://scout.example.com');
  assert.equal(L.normalizeServerUrl('ftp://example.com'), null);
  assert.equal(L.normalizeServerUrl('javascript:alert(1)'), null);
  assert.equal(L.normalizeServerUrl('http://user:pw@example.com'), null);
  assert.equal(L.normalizeServerUrl(''), null);
  assert.equal(L.normalizeServerUrl(undefined), null);

  // Match patterns without a port match every port.
  assert.equal(L.originPattern('https://scout.example.com:8443'), 'https://scout.example.com/*');
  assert.equal(L.originPattern('http://localhost:3000'), 'http://localhost/*');
  assert.ok(manifest.host_permissions.includes(L.originPattern('http://localhost:3000')));
  assert.ok(manifest.host_permissions.includes(L.originPattern('http://127.0.0.1:8080')));

  assert.equal(L.isBuiltinHost('http://localhost:3000'), true);
  assert.equal(L.isBuiltinHost('http://127.0.0.1:5000'), true);
  assert.equal(L.isBuiltinHost('https://localhost:3000'), false, 'https://localhost is not in host_permissions');
  assert.equal(L.isBuiltinHost('http://192.168.1.5:3000'), false);
});

test('basicAuthHeader matches what server.js decodes (UTF-8, any username)', () => {
  assert.equal(L.basicAuthHeader(''), null);
  const h = L.basicAuthHeader('pässwörd:with:colons');
  const m = /^Basic (.+)$/.exec(h);
  assert.ok(m);
  // Same decoding as server.js authorized().
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  assert.equal(pass, 'pässwörd:with:colons');
});

test('checkRequest: only allowlisted method + path pairs pass', () => {
  const ok = [
    ['GET', '/api/status'],
    ['GET', '/api/video?id=dQw4w9WgXcQ&keyword=diy%20desk'],
    ['GET', '/api/channel?q=%40MrBeast&max=50&tz=-60'],
    ['GET', '/api/demand?q=budget+mic&hl=en-GB'],
  ];
  for (const [m, p] of ok) assert.equal(L.isAllowedRequest(m, p), true, `${m} ${p}`);
  assert.equal(L.isAllowedRequest('POST', '/api/tracked', { channel: '@x' }), true);
  assert.equal(L.checkRequest('get', '/api/status').method, 'GET');
  assert.equal(L.checkRequest('GET', '/api/video?id=abc').path, '/api/video?id=abc');

  const bad = [
    ['GET', '/api/tracked'], // not needed by the extension
    ['POST', '/api/tracked/remove', { id: 'UC1' }],
    ['POST', '/api/tracked/refresh', {}],
    ['DELETE', '/api/tracked', { channel: 'x' }],
    ['GET', '/api/me'],
    ['GET', '/api/status/'],
    ['GET', '/api/statusx'],
    ['GET', 'http://evil.example/api/status'],
    ['GET', '//evil.example/api/status'],
    ['GET', '/api/video/../tracked'],
    ['GET', '/api/%2e%2e/me'],
    ['GET', '/api/./status'],
    ['GET', '/api/video\\..\\me'],
    ['GET', '/api/video#frag'],
    ['GET', '/api/video?id=a b'],
    ['GET', '/api/video?id=\n'],
    ['GET', '/auth/google'],
    ['GET', '/'],
    ['GET', `/api/video?id=${'a'.repeat(3000)}`],
    ['GET', null],
    [undefined, '/api/status'],
    ['GET', '/api/status', { unexpected: 'body' }],
    ['POST', '/api/tracked'], // POST needs an object body
    ['POST', '/api/tracked', ['array']],
    ['POST', '/api/tracked', { channel: 'x'.repeat(10_000) }],
  ];
  for (const [m, p, b] of bad) assert.equal(L.isAllowedRequest(m, p, b), false, `${m} ${String(p).slice(0, 60)}`);
});

test('apiPath and dashboardUrl', () => {
  assert.equal(L.apiPath('/api/video', { id: 'dQw4w9WgXcQ', keyword: '' }), '/api/video?id=dQw4w9WgXcQ');
  assert.equal(L.apiPath('/api/channel', { q: '@a&b', max: 50, tz: 0 }), '/api/channel?q=%40a%26b&max=50&tz=0');
  assert.equal(L.apiPath('/api/status'), '/api/status');

  assert.equal(L.dashboardUrl('http://localhost:3000'), 'http://localhost:3000/');
  const url = L.dashboardUrl('http://localhost:3000', { tab: 'keyword', q: 'diy desk & chair' });
  assert.ok(url.startsWith('http://localhost:3000/#tab=keyword&'));
  // Read back the way public/app.js does (hash must start with "#tab=").
  const hash = new URL(url).hash;
  assert.ok(hash.startsWith('#tab='));
  const p = new URLSearchParams(hash.slice(1));
  assert.equal(p.get('tab'), 'keyword');
  assert.equal(p.get('q'), 'diy desk & chair');
  assert.equal(L.dashboardUrl('http://localhost:3000', { tab: 'audit', video: 'dQw4w9WgXcQ' }), 'http://localhost:3000/#tab=audit&video=dQw4w9WgXcQ');
});

test('classifyError and normalizeHl', () => {
  assert.equal(L.classifyError({ networkError: true }), 'offline');
  assert.equal(L.classifyError({ status: 401 }), 'auth');
  assert.equal(L.classifyError({ status: 404, body: { error: 'Not found' } }), 'missing');
  assert.equal(L.classifyError({ status: 404, body: null }), 'missing');
  assert.equal(L.classifyError({ status: 404, body: { error: 'Video not found. It may be private.' } }), 'http');
  assert.equal(L.classifyError({ status: 500, body: { error: 'x' } }), 'http');

  assert.equal(L.normalizeHl('en'), 'en');
  assert.equal(L.normalizeHl('en-GB'), 'en-GB');
  assert.equal(L.normalizeHl('pt_br'), 'pt-BR');
  assert.equal(L.normalizeHl('zh-Hant-TW'), 'zh');
  assert.equal(L.normalizeHl(''), 'en');
  assert.match(L.normalizeHl('de-DE'), /^[a-z]{2}(-[A-Z]{2})?$/, 'matches the server hl check');
});

// ---------- formatting ----------

test('number formatting', () => {
  const cases = [[0, '0'], [7, '7'], [3.44, '3.4'], [950, '950'], [999, '999'], [1000, '1K'], [1234, '1.2K'], [15300, '15K'],
    [999_499, '999K'], [999_950, '1M'], [2_500_000, '2.5M'], [12_345_678, '12M'], [3_100_000_000, '3.1B'], [-4200, '-4.2K']];
  for (const [n, s] of cases) assert.equal(L.formatCompact(n), s, String(n));
  for (const x of [null, undefined, NaN, Infinity, '12']) assert.equal(L.formatCompact(x), '–');

  assert.equal(L.formatPercent(0.0423, 2), '4.23%');
  assert.equal(L.formatPercent(0.05), '5%');
  assert.equal(L.formatPercent(null), '–');
  assert.equal(L.formatMultiplier(3.24), '3.2×');
  assert.equal(L.formatMultiplier(0.456), '0.46×');
  assert.equal(L.formatMultiplier(12.6), '13×');
  assert.equal(L.formatMultiplier(null), '–');

  assert.equal(L.formatAge(0.3), 'today');
  assert.equal(L.formatAge(1.5), '1 day ago');
  assert.equal(L.formatAge(12.9), '12 days ago');
  assert.equal(L.formatAge(120), '3 months ago');
  assert.equal(L.formatAge(800), '2 years ago');
  assert.equal(L.formatAge(null), '');
});

test('topFailedChecks: failed scored checks, most missing points first, max 3', () => {
  const checks = [
    { id: 'a', label: 'A', passed: true, points: 10, maxPoints: 10 },
    { id: 'b', label: 'B', passed: false, points: 6, maxPoints: 10 }, // missing 4
    { id: 'c', label: 'C', passed: false, points: 0, maxPoints: 10 }, // missing 10
    { id: 'd', label: 'D', passed: false, points: 0, maxPoints: 3 }, // missing 3
    { id: 'e', label: 'E', passed: false, points: 0, maxPoints: 8 }, // missing 8
    { id: 'f', label: 'F', passed: true, info: true, points: 0, maxPoints: 0 },
    null,
    { id: 'g', label: 'G', passed: false, points: 0, maxPoints: 0 }, // unscored
  ];
  assert.deepEqual(L.topFailedChecks(checks).map((c) => c.id), ['c', 'e', 'b']);
  assert.deepEqual(L.topFailedChecks(checks, 5).map((c) => c.id), ['c', 'e', 'b', 'd']);
  assert.deepEqual(plain(L.topFailedChecks(undefined)), []);
});

test('strengthExplanation', () => {
  assert.match(L.strengthExplanation({ found: true, prefix: 'how to ed', prefixLength: 9, keywordLength: 18, position: 2, strength: 56 }),
    /after typing “how to ed” \(9 of 18 characters\), at position #2/);
  assert.match(L.strengthExplanation({ found: false, strength: 0 }), /Not suggested/);
  assert.match(L.strengthExplanation({ error: 'timeout' }), /could not be checked: timeout/);
  assert.equal(L.strengthExplanation(null), '');
});

// ---------- service worker ----------

function loadWorker({ settings = {}, granted = false, respond } = {}) {
  let listener = null;
  const storage = { ...settings };
  const pick = (keys) => Object.fromEntries([].concat(keys).filter((k) => k in storage).map((k) => [k, storage[k]]));
  const chrome = {
    runtime: {
      id: 'ext-id',
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { listener = fn; } },
      openOptionsPage: async () => {},
      getURL: (p) => `chrome-extension://ext-id/${p}`,
    },
    storage: { local: { get: async (k) => pick(k), set: async (o) => { Object.assign(storage, o); }, setAccessLevel: async () => {} } },
    permissions: { contains: async () => granted },
  };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = await respond(url, init);
    return { ok: r.status < 400, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  const ctx = vm.createContext({ chrome, fetch, URL, URLSearchParams, TextEncoder, btoa, AbortController, setTimeout, clearTimeout, console });
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
  const call = (msg, sender = { id: 'ext-id', tab: { id: 1 } }) => new Promise((resolve) => {
    const keepOpen = listener(msg, sender, (r) => resolve(plain(r)));
    if (keepOpen !== true) resolve('not handled');
  });
  return { call, calls, storage };
}

test('worker: calls the configured server with Basic auth and JSON body', async () => {
  const w = loadWorker({
    settings: { serverUrl: 'http://localhost:3205', password: 'pw' },
    respond: () => ({ status: 200, body: { id: 'UC1', added: true } }),
  });
  const res = await w.call({ type: 'api', method: 'POST', path: '/api/tracked', body: { channel: 'UCabc' } });
  assert.deepEqual(res, { serverUrl: 'http://localhost:3205', path: '/api/tracked', ok: true, status: 200, data: { id: 'UC1', added: true } });
  assert.equal(w.calls.length, 1);
  const { url, init } = w.calls[0];
  assert.equal(url, 'http://localhost:3205/api/tracked');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from('tubescout:pw').toString('base64')}`);
  assert.equal(init.body, JSON.stringify({ channel: 'UCabc' }));
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
});

test('worker: refuses non-allowlisted requests without touching the network', async () => {
  const w = loadWorker({ respond: () => ({ status: 200, body: {} }) });
  for (const msg of [
    { type: 'api', method: 'POST', path: '/api/tracked/remove', body: { id: 'UC1' } },
    { type: 'api', method: 'GET', path: 'https://evil.example/steal' },
    { type: 'api', method: 'GET', path: '//evil.example/api/status' },
    { type: 'api', method: 'GET', path: '/api/me' },
  ]) {
    const res = await w.call(msg);
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'forbidden');
  }
  assert.equal(w.calls.length, 0);
  // Other extensions, unknown message types and prototype keys are ignored.
  assert.equal(await w.call({ type: 'api', method: 'GET', path: '/api/status' }, { id: 'other-ext' }), 'not handled');
  assert.equal(await w.call({ type: 'fetch', url: 'https://evil.example' }), 'not handled');
  assert.equal(await w.call({ type: 'constructor' }), 'not handled');
  assert.equal(await w.call(null), 'not handled');
  assert.equal(w.calls.length, 0);
});

test('worker: defaults to localhost:3000, never exposes the password via config', async () => {
  const w = loadWorker({ settings: { password: 'secret' }, respond: () => ({ status: 200, body: { mode: 'demo' } }) });
  const res = await w.call({ type: 'api', method: 'GET', path: '/api/status' });
  assert.equal(res.ok, true);
  assert.equal(w.calls[0].url, 'http://localhost:3000/api/status');
  const cfg = await w.call({ type: 'config' });
  assert.deepEqual(cfg, { ok: true, serverUrl: 'http://localhost:3000' });
  assert.doesNotMatch(JSON.stringify(cfg), /secret/);
});

test('worker: classifies failures (offline, auth, missing endpoint, permission, non-JSON)', async () => {
  const offline = loadWorker({ respond: () => { throw new TypeError('Failed to fetch'); } });
  assert.equal((await offline.call({ type: 'api', method: 'GET', path: '/api/status' })).kind, 'offline');

  const auth = loadWorker({ settings: { password: 'wrong' }, respond: () => ({ status: 401, body: 'Authentication required' }) });
  const a = await auth.call({ type: 'api', method: 'GET', path: '/api/status' });
  assert.equal(a.kind, 'auth');
  assert.equal(a.sentPassword, true);

  const old = loadWorker({ respond: () => ({ status: 404, body: { error: 'Not found' } }) });
  const m = await old.call({ type: 'api', method: 'GET', path: '/api/video?id=dQw4w9WgXcQ' });
  assert.equal(m.kind, 'missing');
  assert.equal(m.path, '/api/video');

  const gone = loadWorker({ respond: () => ({ status: 404, body: { error: 'Video not found. It may be private.' } }) });
  const g = await gone.call({ type: 'api', method: 'GET', path: '/api/video?id=dQw4w9WgXcQ' });
  assert.equal(g.kind, 'http');
  assert.equal(g.error, 'Video not found. It may be private.');

  const remote = loadWorker({ settings: { serverUrl: 'https://scout.example.com' }, granted: false, respond: () => ({ status: 200, body: {} }) });
  assert.equal((await remote.call({ type: 'api', method: 'GET', path: '/api/status' })).kind, 'permission');
  assert.equal(remote.calls.length, 0);

  const html = loadWorker({ respond: () => ({ status: 200, body: '<!doctype html><title>Some other app</title>' }) });
  const hres = await html.call({ type: 'api', method: 'GET', path: '/api/status' });
  assert.equal(hres.ok, false);
  assert.match(hres.error, /not with TubeScout data/);
});

test('worker: stores the collapsed preference', async () => {
  const w = loadWorker({ respond: () => ({ status: 200, body: {} }) });
  assert.deepEqual(await w.call({ type: 'getPrefs' }), { ok: true, collapsed: false });
  await w.call({ type: 'setPrefs', collapsed: true });
  assert.deepEqual(await w.call({ type: 'getPrefs' }), { ok: true, collapsed: true });
  assert.equal(w.storage.collapsed, true);
});
