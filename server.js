// Zero-dependency HTTP server: JSON API + static frontend.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YouTubeClient } from './src/youtube.js';
import { DemoClient } from './src/demo.js';
import { analyzeChannel, compareChannels, researchKeyword } from './src/service.js';
import { searchDemand } from './src/demand.js';
import { JsonStore } from './src/store.js';
import { Tracker } from './src/tracker.js';
import { GoogleOAuth } from './src/oauth.js';
import { ChannelAnalytics } from './src/ytanalytics.js';
import { EventEmitter } from 'node:events';
import { FEATURES } from './src/features/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// Minimal .env loader so users don't need a dependency.
try {
  const env = await readFile(path.join(ROOT, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file */ }

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const HOST = env.HOST || '127.0.0.1';
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DEMO = !env.YOUTUBE_API_KEY || env.DEMO === '1';
const APP_PASSWORD = env.APP_PASSWORD || '';
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

const client = DEMO ? new DemoClient() : new YouTubeClient(env.YOUTUBE_API_KEY);
const store = new JsonStore(path.resolve(ROOT, env.DATA_DIR || 'data'));
const events = new EventEmitter(); // 'snapshot' (tracker) and 'ranks' (rank tracker) events; alerts subscribe
const tracker = new Tracker({ client, store, log: (m) => console.warn(m), onSnapshot: (e) => { events.emit('snapshot', e); } });
const oauth = new GoogleOAuth({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  redirectUri: `${PUBLIC_URL}/auth/google/callback`,
  includeRevenue: env.ENABLE_REVENUE === '1',
  store,
});
const channelAnalytics = new ChannelAnalytics({ oauth });

if (!isLoopback && !APP_PASSWORD) {
  console.error(`Refusing to listen on ${HOST} without APP_PASSWORD: anyone on the network could use your API quota${oauth.configured ? ' and read your private channel analytics' : ''}. Set APP_PASSWORD in .env.`);
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const intParam = (v, def, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const regionParam = (v) => (/^[A-Za-z]{2}$/.test(v || '') ? v.toUpperCase() : undefined);
const hash = (s) => createHash('sha256').update(String(s)).digest();

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return timingSafeEqual(hash(pass), hash(APP_PASSWORD));
}

async function readJson(req) {
  // Requiring a JSON content type means browsers must send a CORS preflight,
  // which blocks other websites from POSTing to this local server (CSRF).
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Expected application/json');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw httpError(413, 'Request too large');
    chunks.push(c);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw httpError(400, 'Invalid JSON'); }
}

const meta = () => ({
  mode: DEMO ? 'demo' : 'live',
  quotaUsedSinceStart: client.quotaUsed,
  searchCallsSinceStart: client.searchCalls ?? 0,
  integrations: {
    trends: Boolean(env.SERPAPI_KEY),
    volume: Boolean(env.KE_API_KEY),
    oauth: oauth.configured,
    ai: Boolean(env.ANTHROPIC_API_KEY || env.AI_ENABLED === '1'),
    alerts: Boolean(env.TELEGRAM_BOT_TOKEN || env.ALERT_WEBHOOK_URL),
  },
});

const routes = {
  'GET /api/status': async () => meta(),

  'GET /api/channel': async (url) => ({
    ...(await analyzeChannel(client, url.searchParams.get('q'), { tz: intParam(url.searchParams.get('tz'), 0, -840, 840), max: intParam(url.searchParams.get('max'), 50, 10, 200) })),
    meta: meta(),
  }),

  'GET /api/compare': async (url) => {
    const inputs = url.searchParams.getAll('q');
    if (!inputs.length) throw httpError(400, 'Add at least one channel.');
    return { ...(await compareChannels(client, inputs, { tz: intParam(url.searchParams.get('tz'), 0, -840, 840), max: intParam(url.searchParams.get('max'), 50, 10, 100) })), meta: meta() };
  },

  'GET /api/keyword': async (url) => ({
    ...(await researchKeyword(client, url.searchParams.get('q'), { max: intParam(url.searchParams.get('max'), 25, 5, 50), regionCode: regionParam(url.searchParams.get('region')) })),
    meta: meta(),
  }),

  'GET /api/demand': async (url) => ({
    ...(await searchDemand(url.searchParams.get('q'), {
      region: regionParam(url.searchParams.get('region')),
      hl: /^[a-z]{2}(-[A-Z]{2})?$/.test(url.searchParams.get('hl') || '') ? url.searchParams.get('hl') : 'en',
      serpApiKey: env.SERPAPI_KEY,
      keKey: env.KE_API_KEY,
      keCountry: env.KE_COUNTRY,
      keMaxKeywords: intParam(env.KE_MAX_KEYWORDS, 20, 0, 99),
    })),
    meta: meta(),
  }),

  'GET /api/tracked': async () => ({ ...(await tracker.report()), meta: meta() }),
  'POST /api/tracked': async (url, req) => {
    const { channel } = await readJson(req);
    if (!channel || typeof channel !== 'string') throw httpError(400, 'Enter a channel to track.');
    return tracker.add(channel);
  },
  'POST /api/tracked/remove': async (url, req) => {
    const { id } = await readJson(req);
    if (!id) throw httpError(400, 'Missing channel id.');
    await tracker.remove(String(id));
    return { ok: true };
  },
  'POST /api/tracked/refresh': async (url, req) => {
    await readJson(req);
    return { results: await tracker.runDue({ force: true }) };
  },

  'GET /api/me': async () => {
    if (!oauth.configured) return { configured: false, connected: false };
    if (!(await store.read('oauth', null))) return { configured: true, connected: false };
    try {
      return { configured: true, connected: true, ...(await channelAnalytics.overview(28)) };
    } catch (e) {
      if (e.status === 401) return { configured: true, connected: false, error: 'Your Google sign-in expired or was revoked. Please connect again.' };
      throw e;
    }
  },
  'GET /api/me/overview': async (url) => channelAnalytics.overview(intParam(url.searchParams.get('days'), 28, 7, 365)),
  'GET /api/me/retention': async (url) => channelAnalytics.retention(url.searchParams.get('video')),
  'POST /auth/logout': async (url, req) => { await readJson(req); await oauth.disconnect(); return { ok: true }; },
};

// ---- Feature modules (src/features/*.js) plug in their own routes and background jobs ----
const ctx = {
  env, DEMO, client, store, tracker, oauth, channelAnalytics, events, meta,
  readJson, httpError, intParam, regionParam, log: (...a) => console.warn(...a),
};
const features = [];
for (const create of FEATURES) {
  const f = await create(ctx);
  for (const [key, handler] of Object.entries(f.routes || {})) {
    if (routes[key]) throw new Error(`Feature route collides with an existing route: ${key}`);
    routes[key] = handler;
  }
  features.push(f);
}

async function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    send(res, 200, await readFile(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const redirect = (res, location) => { res.writeHead(302, { Location: location, ...SECURITY_HEADERS }); res.end(); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!authorized(req)) return send(res, 401, 'Authentication required', 'text/plain', { 'WWW-Authenticate': 'Basic realm="TubeScout"' });

  if (req.method === 'GET' && url.pathname === '/auth/google') {
    if (!oauth.configured) return send(res, 400, 'Google sign-in is not configured. See README: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.', 'text/plain');
    return redirect(res, oauth.authUrl());
  }
  if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
    try {
      if (url.searchParams.get('error')) throw httpError(400, url.searchParams.get('error'));
      await oauth.handleCallback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      return redirect(res, '/#me');
    } catch (e) {
      return redirect(res, `/#me-error=${encodeURIComponent(e.message)}`);
    }
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url, res);
    return send(res, 404, { error: 'Not found' });
  }
  try {
    send(res, 200, await handler(url, req));
  } catch (e) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || 'Something went wrong' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TubeScout running at ${PUBLIC_URL}  (listening on ${HOST}:${PORT})`);
  console.log(DEMO
    ? 'DEMO MODE: channel data is synthetic. Set YOUTUBE_API_KEY in .env for real channels.'
    : 'Live mode: using the YouTube Data API v3.');
  console.log(`Integrations: Google Trends ${env.SERPAPI_KEY ? 'ON' : 'off'} · Keyword volume ${env.KE_API_KEY ? 'ON' : 'off'} · My channel login ${oauth.configured ? 'ON' : 'off'}`);
});

// Daily snapshots of tracked channels: check hourly, snapshot anything older than ~20h.
const runSnapshots = () => tracker.runDue().catch((e) => console.warn('Snapshot run failed:', e.message));
if (env.DISABLE_SCHEDULER !== '1') {
  setTimeout(runSnapshots, 10_000).unref();
  setInterval(runSnapshots, 3600_000).unref();
  for (const f of features) f.start?.();
}
