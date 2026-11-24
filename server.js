// Zero-dependency HTTP server: JSON API + static frontend.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YouTubeClient } from './src/youtube.js';
import { DemoClient } from './src/demo.js';
import { analyzeChannel, compareChannels, researchKeyword } from './src/service.js';

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

const API_KEY = process.env.YOUTUBE_API_KEY;
const DEMO = !API_KEY || process.env.DEMO === '1';
const client = DEMO ? new DemoClient() : new YouTubeClient(API_KEY);
const PORT = Number(process.env.PORT) || 3000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const intParam = (v, def, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

async function handleApi(url) {
  const tz = intParam(url.searchParams.get('tz'), 0, -840, 840);
  const max = intParam(url.searchParams.get('max'), 50, 10, 200);
  const meta = () => ({ mode: DEMO ? 'demo' : 'live', quotaUsedSinceStart: client.quotaUsed });
  switch (url.pathname) {
    case '/api/status':
      return meta();
    case '/api/channel':
      return { ...(await analyzeChannel(client, url.searchParams.get('q'), { tz, max })), meta: meta() };
    case '/api/compare': {
      const inputs = url.searchParams.getAll('q');
      if (!inputs.length) throw Object.assign(new Error('Add at least one channel.'), { status: 400 });
      return { ...(await compareChannels(client, inputs, { tz, max })), meta: meta() };
    }
    case '/api/keyword':
      return {
        ...(await researchKeyword(client, url.searchParams.get('q'), {
          max: intParam(url.searchParams.get('max'), 25, 5, 50),
          regionCode: /^[A-Z]{2}$/.test(url.searchParams.get('region') || '') ? url.searchParams.get('region') : undefined,
        })),
        meta: meta(),
      };
    default:
      throw Object.assign(new Error('Not found'), { status: 404 });
  }
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
  try {
    send(res, 200, await handleApi(url));
  } catch (e) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || 'Something went wrong' });
  }
});

server.listen(PORT, () => {
  console.log(`TubeScout running at http://localhost:${PORT}`);
  console.log(DEMO
    ? 'DEMO MODE: showing synthetic data. Set YOUTUBE_API_KEY in .env for real channels.'
    : 'Live mode: using the YouTube Data API v3.');
});
