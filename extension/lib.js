// TubeScout extension: pure helpers shared by the content script, the service
// worker, the options page, the popup and the Node tests.
//
// Loaded as a classic script everywhere (content_scripts list, importScripts in
// the worker, <script> tags in the pages), so it defines `TubeScoutLib` on the
// global object. Node tests run it the same way in a vm context. No DOM, no
// chrome.* APIs in here.
(function (root) {
  'use strict';

  const DEFAULT_SERVER = 'http://localhost:3000';
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
  const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com']);
  // Hosts covered by the manifest's host_permissions (match patterns ignore the port).
  const BUILTIN_HOSTS = new Set(['localhost', '127.0.0.1']);

  // The only server endpoints the worker will call: exact method + pathname.
  const ALLOWED_REQUESTS = Object.freeze([
    'GET /api/status',
    'GET /api/video',
    'GET /api/channel',
    'GET /api/demand',
    'POST /api/tracked',
  ]);
  const MAX_PATH_LENGTH = 2048;
  const MAX_BODY_BYTES = 8 * 1024;

  const safeDecode = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };

  // ---------- YouTube page detection ----------

  /**
   * Classify a YouTube URL.
   * Returns { type: 'video', videoId, isShort } | { type: 'channel', channel } |
   * { type: 'search', query } | { type: null }.
   * `channel` is something the server's /api/channel accepts: a UC... id, an @handle,
   * or a /user/ URL (legacy usernames).
   */
  function parsePage(href) {
    let u;
    try { u = new URL(href); } catch { return { type: null }; }
    if (!/^https?:$/.test(u.protocol) || !YOUTUBE_HOSTS.has(u.hostname)) return { type: null };
    const parts = u.pathname.split('/').filter(Boolean);
    const first = parts[0] || '';

    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v') || '';
      return VIDEO_ID_RE.test(v) ? { type: 'video', videoId: v, isShort: false } : { type: null };
    }
    if ((first === 'shorts' || first === 'live') && VIDEO_ID_RE.test(parts[1] || '')) {
      return { type: 'video', videoId: parts[1], isShort: first === 'shorts' };
    }
    if (first === 'results') {
      const q = (u.searchParams.get('search_query') || '').replace(/\s+/g, ' ').trim();
      return q ? { type: 'search', query: q.slice(0, 200) } : { type: null };
    }
    if (first === 'channel' && CHANNEL_ID_RE.test(parts[1] || '')) {
      return { type: 'channel', channel: parts[1] };
    }
    if (first.startsWith('@')) {
      const handle = safeDecode(first);
      // Handles are 3-30 characters; allow some slack but reject anything odd.
      return /^@[^\s/?#]{1,100}$/.test(handle) ? { type: 'channel', channel: handle } : { type: null };
    }
    if (first === 'user' && /^[\w.-]{1,100}$/.test(parts[1] || '')) {
      return { type: 'channel', channel: `https://www.youtube.com/user/${parts[1]}` };
    }
    return { type: null };
  }

  /** Stable identity of a page: navigating within the same video/channel/search keeps the panel. */
  function pageKey(page) {
    if (!page || !page.type) return '';
    if (page.type === 'video') return `video:${page.videoId}`;
    if (page.type === 'channel') return `channel:${page.channel.toLowerCase()}`;
    return `search:${page.query.toLowerCase()}`;
  }

  // ---------- Server URL, permissions, auth ----------

  /** Normalize what the user typed into an origin like "http://localhost:3000", or null if unusable. */
  function normalizeServerUrl(input) {
    let s = String(input == null ? '' : input).trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || !u.hostname) return null; // the password has its own field
    return u.origin;
  }

  /** Match pattern for chrome.permissions ("http://example.com/*"); patterns without a port match all ports. */
  function originPattern(serverUrl) {
    const u = new URL(serverUrl);
    return `${u.protocol}//${u.hostname}/*`;
  }

  /** True when the manifest's host_permissions already cover this server (http on localhost/127.0.0.1). */
  function isBuiltinHost(serverUrl) {
    try {
      const u = new URL(serverUrl);
      return u.protocol === 'http:' && BUILTIN_HOSTS.has(u.hostname);
    } catch { return false; }
  }

  /** base64 of UTF-8 bytes (btoa alone only handles Latin-1). */
  function base64Utf8(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  /** The server accepts any username; only the password is checked. */
  function basicAuthHeader(password) {
    return password ? `Basic ${base64Utf8(`tubescout:${password}`)}` : null;
  }

  /**
   * Validate a request coming from a content script. Only exact allowlisted
   * method + pathname pairs pass; the path must be a plain absolute path on the
   * configured server (no scheme, no //host, no dot segments, no fragments).
   * Returns { ok: true, method, path } or { ok: false, reason }.
   */
  function checkRequest(method, path, body) {
    const m = typeof method === 'string' ? method.toUpperCase() : '';
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.length > MAX_PATH_LENGTH) {
      return { ok: false, reason: 'Path not allowed' };
    }
    if (/[\s\\#\u0000-\u001f\u007f]/.test(path) || path.startsWith('//')) return { ok: false, reason: 'Path not allowed' };
    const raw = path.split('?')[0];
    let u;
    try { u = new URL(path, 'http://server.invalid'); } catch { return { ok: false, reason: 'Path not allowed' }; }
    // URL parsing resolves "..", "%2e%2e" and friends; any difference means the path was not plain.
    if (u.origin !== 'http://server.invalid' || u.pathname !== raw) return { ok: false, reason: 'Path not allowed' };
    if (!ALLOWED_REQUESTS.includes(`${m} ${u.pathname}`)) return { ok: false, reason: `${m} ${u.pathname} is not allowed` };
    if (m === 'GET' && body != null) return { ok: false, reason: 'GET requests take no body' };
    if (m === 'POST') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'POST body must be an object' };
      if (JSON.stringify(body).length > MAX_BODY_BYTES) return { ok: false, reason: 'Body too large' };
    }
    return { ok: true, method: m, path: u.pathname + u.search };
  }

  const isAllowedRequest = (method, path, body) => checkRequest(method, path, body).ok;

  /** Build an /api path with a query string, skipping empty values. */
  function apiPath(pathname, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `${pathname}?${s}` : pathname;
  }

  /** Dashboard deep link, e.g. dashboardUrl(server, { tab: 'keyword', q: 'diy desk' }) -> server/#tab=keyword&q=diy+desk. */
  function dashboardUrl(serverUrl, params) {
    const base = `${serverUrl}/`;
    if (!params || !params.tab) return base;
    const qs = new URLSearchParams();
    qs.set('tab', params.tab); // the dashboard only reads hashes that start with "tab="
    for (const [k, v] of Object.entries(params)) if (k !== 'tab' && v) qs.set(k, String(v));
    return `${base}#${qs.toString()}`;
  }

  /**
   * Turn a failed request into something the UI can explain.
   * kind: 'offline' | 'auth' | 'missing' | 'http' (the worker adds 'timeout', 'permission', 'forbidden')
   */
  function classifyError({ status, body, networkError } = {}) {
    if (networkError) return 'offline';
    if (status === 401) return 'auth';
    // An unknown route on the TubeScout server answers exactly { error: 'Not found' };
    // a real "video not found" carries a longer message.
    if (status === 404 && (!body || typeof body !== 'object' || body.error === 'Not found')) return 'missing';
    return 'http';
  }

  /** YouTube's UI language (html[lang]) -> the hl value /api/demand accepts. */
  function normalizeHl(lang) {
    const m = /^([a-z]{2})(?:[-_]([a-z]{2}))?\b/i.exec(String(lang || ''));
    if (!m) return 'en';
    return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase();
  }

  // ---------- Formatting ----------

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  function trimZero(s) {
    return s.replace(/\.0$/, '');
  }

  /** 950 -> "950", 1234 -> "1.2K", 15300 -> "15K", 2.5e6 -> "2.5M"; small fractions keep one decimal. */
  function formatCompact(n) {
    if (!isNum(n)) return '–';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (let i = 0; i < units.length; i++) {
      const [size, suffix] = units[i];
      if (a < size) continue;
      const v = a / size;
      const s = v >= 10 ? String(Math.round(v)) : trimZero(v.toFixed(1));
      // 999,950 rounds to "1000K": show the next unit ("1M") instead.
      if (s === '1000' && i > 0) return `${sign}1${units[i - 1][1]}`;
      return sign + s + suffix;
    }
    if (a < 10 && a % 1 !== 0) return sign + trimZero(a.toFixed(1));
    return sign + String(Math.round(a));
  }

  /** 0.0423 -> "4.2%". Input is a fraction. */
  function formatPercent(fraction, digits) {
    if (!isNum(fraction)) return '–';
    return `${trimZero((fraction * 100).toFixed(digits == null ? 1 : digits))}%`;
  }

  /** Outlier score: 3.24 -> "3.2×", 0.45 -> "0.45×", 12.6 -> "13×". */
  function formatMultiplier(x) {
    if (!isNum(x)) return '–';
    if (x >= 10) return `${Math.round(x)}×`;
    if (x < 1) return `${x.toFixed(2)}×`;
    return `${x.toFixed(1)}×`;
  }

  /** Age in days -> "today", "1 day ago", "12 days ago", "4 months ago", "3 years ago". */
  function formatAge(days) {
    if (!isNum(days) || days < 0) return '';
    if (days < 1) return 'today';
    if (days < 2) return '1 day ago';
    if (days < 60) return `${Math.floor(days)} days ago`;
    if (days < 730) return `${Math.floor(days / 30.44)} months ago`;
    return `${Math.floor(days / 365.25)} years ago`;
  }

  /** The SEO checks worth fixing first: failed, scored checks with the most points missing. */
  function topFailedChecks(checks, n) {
    if (!Array.isArray(checks)) return [];
    return checks
      .filter((c) => c && typeof c === 'object' && c.passed === false && !c.info && isNum(c.maxPoints) && c.maxPoints > 0)
      .map((c, i) => ({ c, i, missing: c.maxPoints - (isNum(c.points) ? c.points : 0) }))
      .sort((a, b) => b.missing - a.missing || a.i - b.i)
      .slice(0, n == null ? 3 : n)
      .map((x) => x.c);
  }

  /** Plain-language explanation of the autocomplete strength result (mirrors the dashboard wording). */
  function strengthExplanation(ac) {
    if (!ac || typeof ac !== 'object') return '';
    if (ac.error) return `YouTube autocomplete could not be checked: ${ac.error}`;
    if (!ac.found) return 'Not suggested by YouTube even when typed in full: very few people search this exact phrase.';
    const pos = isNum(ac.position) ? `, at position #${ac.position}` : '';
    return `YouTube suggests it after typing “${ac.prefix}” (${ac.prefixLength} of ${ac.keywordLength} characters)${pos}. The earlier it appears, the more people search it.`;
  }

  /**
   * A rejected chrome.runtime.sendMessage, as the same { ok: false, kind } shape the worker returns.
   * Chrome stops an extension service worker whose network request gets no response for 30s; the
   * pending reply then fails with Chromium's "...message channel closed before a response was
   * received" (or "The message port closed..."), which means the server was too slow.
   */
  function messagingFailure(e) {
    const msg = String((e && e.message) || e || '');
    if (/message (channel|port) closed/i.test(msg)) {
      return { ok: false, kind: 'timeout', error: 'Your TubeScout server took too long to answer, so Chrome stopped the request.' };
    }
    return { ok: false, kind: 'extension', error: msg || 'No answer from the extension.' };
  }

  const api = {
    DEFAULT_SERVER,
    ALLOWED_REQUESTS,
    VIDEO_ID_RE,
    CHANNEL_ID_RE,
    parsePage,
    pageKey,
    normalizeServerUrl,
    originPattern,
    isBuiltinHost,
    base64Utf8,
    basicAuthHeader,
    checkRequest,
    isAllowedRequest,
    apiPath,
    dashboardUrl,
    classifyError,
    normalizeHl,
    formatCompact,
    formatPercent,
    formatMultiplier,
    formatAge,
    topFailedChecks,
    strengthExplanation,
    messagingFailure,
  };

  root.TubeScoutLib = Object.freeze(api);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
