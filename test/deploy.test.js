// Hosting on Render (render.yaml + DEPLOY.md): the public /healthz endpoint, the RENDER_EXTERNAL_URL
// fallback for the Google sign-in redirect, graceful SIGTERM shutdown, and a sanity check of render.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { publicUrl } from '../src/oauth.js';
import { JsonStore } from '../src/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Just enough of render.yaml for the checks below: top-level service fields, the disk block and the
 * envVars list. (The file is a small, flat Blueprint; a full YAML parser is not a project dependency.)
 */
function parseBlueprint(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const service = { disk: {}, envVars: [] };
  let section = null;
  for (const line of lines) {
    const m = /^(\s*)(- )?([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, dash, key, raw] = m;
    const value = raw.replace(/\s+#.*$/, '').replace(/^"(.*)"$/, '$1');
    if (indent.length <= 4 && !(dash && key === 'key')) section = null;
    if (key === 'disk' || key === 'envVars') { section = key; continue; }
    if (section === 'disk') service.disk[key] = value;
    else if (section === 'envVars') {
      if (dash && key === 'key') service.envVars.push({ key: value });
      else service.envVars.at(-1)[key] = value;
    } else service[key] = value;
  }
  return service;
}

async function startServer(t, extraEnv) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tubescout-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const password = 'deploy-test-password';
  // Pin everything that matters: server.js only fills variables from the repo's .env when they are unset here.
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', APP_PASSWORD: password, DATA_DIR: dir, DISABLE_SCHEDULER: '1', DEMO: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10_000);
    child.stdout.on('data', (b) => { out += b; if (/Integrations: .*\n/.test(out)) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (b) => { out += b; });
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
  });
  return {
    child, dir, exited, log: () => out,
    base: `http://127.0.0.1:${port}`,
    auth: { Authorization: `Basic ${Buffer.from(`anyone:${password}`).toString('base64')}` },
  };
}

test('publicUrl: PUBLIC_URL, then RENDER_EXTERNAL_URL, then http://localhost:PORT', () => {
  assert.equal(publicUrl({}, 3000), 'http://localhost:3000');
  assert.equal(publicUrl({ RENDER_EXTERNAL_URL: 'https://tubescout-x1.onrender.com' }, 10000), 'https://tubescout-x1.onrender.com');
  assert.equal(publicUrl({ PUBLIC_URL: 'https://yt.example.com/', RENDER_EXTERNAL_URL: 'https://tubescout-x1.onrender.com' }, 10000), 'https://yt.example.com');
  assert.equal(publicUrl({ PUBLIC_URL: '', RENDER_EXTERNAL_URL: '' }, 4000), 'http://localhost:4000', 'empty values mean "unset"');
});

test('JsonStore.flush waits for queued writes, including ones queued meanwhile', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tubescout-flush-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir);
  store.write('a', { n: 1 });
  store.update('b', { n: 0 }, async (cur) => { store.write('c', { n: 3 }); return { n: cur.n + 2 }; });
  await store.flush();
  assert.deepEqual(await store.read('a'), { n: 1 });
  assert.deepEqual(await store.read('b'), { n: 2 });
  assert.deepEqual(await store.read('c'), { n: 3 });
  await new JsonStore(dir).flush(); // nothing queued: resolves at once
});

test('Render-like run: /healthz is public and minimal, the rest needs the password, sign-in uses RENDER_EXTERNAL_URL, SIGTERM exits cleanly', async (t) => {
  const external = 'https://tubescout-test.onrender.com';
  const s = await startServer(t, { RENDER_EXTERNAL_URL: external, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' });
  assert.match(s.log(), new RegExp(`TubeScout running at ${external.replace(/\./g, '\\.')} `));

  // Health check: no password, exactly {"ok":true}, nothing about mode, keys or versions.
  const h = await fetch(`${s.base}/healthz`);
  assert.equal(h.status, 200);
  assert.equal(await h.text(), '{"ok":true}');
  assert.equal(h.headers.get('www-authenticate'), null);
  assert.equal((await fetch(`${s.base}/healthz`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${s.base}/healthz`, { method: 'POST' })).status, 401, 'only GET/HEAD are public');
  assert.equal((await fetch(`${s.base}/healthz/x`)).status, 401);

  // Everything else still requires APP_PASSWORD.
  for (const p of ['/', '/api/status', '/api/tracked', '/auth/google']) assert.equal((await fetch(`${s.base}${p}`, { redirect: 'manual' })).status, 401, p);
  assert.equal((await fetch(`${s.base}/api/status`, { headers: s.auth })).status, 200);

  // Google sign-in redirect URI comes from RENDER_EXTERNAL_URL when PUBLIC_URL is not set.
  const r = await fetch(`${s.base}/auth/google`, { headers: s.auth, redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('location')).searchParams.get('redirect_uri'), `${external}/auth/google/callback`);

  // Data lands in DATA_DIR.
  const add = await fetch(`${s.base}/api/tracked`, { method: 'POST', headers: { ...s.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: '@demo' }) });
  assert.equal(add.status, 200);
  assert.ok((await readdir(s.dir)).some((f) => f.endsWith('.json')), 'a JSON data file in DATA_DIR');

  s.child.kill('SIGTERM');
  const { code } = await s.exited;
  assert.equal(code, 0, s.log());
  assert.match(s.log(), /SIGTERM received/);
  assert.ok(!(await readdir(s.dir)).some((f) => f.endsWith('.tmp')), 'no half-written temp files left');
});

test('PUBLIC_URL still wins over RENDER_EXTERNAL_URL (custom domain)', async (t) => {
  const s = await startServer(t, { PUBLIC_URL: 'https://yt.example.com', RENDER_EXTERNAL_URL: 'https://tubescout-test.onrender.com', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
  const r = await fetch(`${s.base}/auth/google`, { headers: s.auth, redirect: 'manual' });
  assert.equal(new URL(r.headers.get('location')).searchParams.get('redirect_uri'), 'https://yt.example.com/auth/google/callback');
});

test('render.yaml: one Node web service with a disk at DATA_DIR, the server health route, and no committed secrets', async () => {
  const text = await readFile(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.equal((text.match(/^\s*- type:/gm) || []).length, 1, 'exactly one service');
  const svc = parseBlueprint(text);
  assert.equal(svc.type, 'web');
  assert.equal(svc.runtime, 'node');
  assert.ok(svc.name && svc.plan && svc.plan !== 'free', 'a paid plan (persistent disks need one)');
  assert.ok(['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'].includes(svc.region), `region ${svc.region}`);
  // node directly (not `npm start`), so Render's SIGTERM reaches the graceful shutdown in server.js.
  assert.equal(svc.startCommand, 'node server.js');
  assert.equal(JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).scripts.start, svc.startCommand, 'same command as npm start');
  assert.match(svc.buildCommand, /^npm (ci|install)\b/);
  assert.ok(['commit', 'checksPass', 'off'].includes(svc.autoDeployTrigger));

  const env = Object.fromEntries(svc.envVars.map((v) => [v.key, v]));
  assert.equal(env.HOST?.value, '0.0.0.0', 'Render routes traffic to 0.0.0.0');
  assert.ok(svc.disk.mountPath?.startsWith('/') && Number(svc.disk.sizeGB) >= 1, 'a persistent disk');
  assert.equal(env.DATA_DIR?.value, svc.disk.mountPath, 'DATA_DIR must be on the persistent disk');
  assert.equal(svc.healthCheckPath, '/healthz', 'the public health route in server.js');
  const engines = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).engines.node;
  assert.ok(Number(env.NODE_VERSION?.value.split('.')[0]) >= Number(/\d+/.exec(engines)[0]), 'NODE_VERSION satisfies package.json engines');
  assert.ok(!('PORT' in env), 'Render sets PORT itself');

  // Secrets are prompted for (sync: false), never written into the file.
  for (const key of ['YOUTUBE_API_KEY', 'APP_PASSWORD']) assert.equal(env[key]?.sync, 'false', `${key} is asked for at setup`);
  const secretish = /KEY|SECRET|TOKEN|PASSWORD|WEBHOOK|CLIENT_ID|CHAT_ID/;
  for (const v of svc.envVars) if (secretish.test(v.key)) assert.ok(!('value' in v) && v.sync === 'false', `${v.key} must not have a committed value`);
  assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}|sk-ant-|\d{6,}:[A-Za-z0-9_-]{30,}|hooks\.slack\.com|discord(app)?\.com\/api\/webhooks/, 'no key-shaped strings');
});

test('render.free.yaml: free test variant without a disk, same health route and prompted secrets', async () => {
  const text = await readFile(path.join(ROOT, 'render.free.yaml'), 'utf8');
  assert.equal((text.match(/^\s*- type:/gm) || []).length, 1, 'exactly one service');
  const svc = parseBlueprint(text);
  assert.equal(svc.type, 'web');
  assert.equal(svc.runtime, 'node');
  assert.equal(svc.plan, 'free');
  assert.deepEqual(svc.disk, {}, 'Render free web services cannot have a persistent disk');
  assert.equal(svc.startCommand, 'node server.js');
  assert.match(svc.buildCommand, /^npm (ci|install)\b/);
  assert.equal(svc.healthCheckPath, '/healthz');
  const env = Object.fromEntries(svc.envVars.map((v) => [v.key, v]));
  assert.equal(env.HOST?.value, '0.0.0.0');
  assert.ok(!('DATA_DIR' in env), 'no disk, so the default data/ folder (ephemeral) is used');
  assert.ok(!('PORT' in env), 'Render sets PORT itself');
  for (const key of ['YOUTUBE_API_KEY', 'APP_PASSWORD']) assert.equal(env[key]?.sync, 'false', `${key} is asked for at setup`);
  const secretish = /KEY|SECRET|TOKEN|PASSWORD|WEBHOOK|CLIENT_ID|CHAT_ID/;
  for (const v of svc.envVars) if (secretish.test(v.key)) assert.ok(!('value' in v) && v.sync === 'false', `${v.key} must not have a committed value`);
  assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}|sk-ant-/, 'no key-shaped strings');
  // The paid and free services must have different names so both can exist in one workspace.
  assert.notEqual(svc.name, parseBlueprint(await readFile(path.join(ROOT, 'render.yaml'), 'utf8')).name);
});
