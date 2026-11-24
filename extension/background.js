// TubeScout extension service worker. It is the only part of the extension that
// talks to the network, and it only calls the allowlisted endpoints of the
// user's own TubeScout server (see ALLOWED_REQUESTS in lib.js). Content scripts
// run on youtube.com, so their messages are treated as untrusted input.
'use strict';

importScripts('lib.js');
const L = self.TubeScoutLib;
// Chrome stops an extension service worker when a fetch() response takes more than 30s
// (developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
// so give up a little earlier and report a clear timeout instead.
const TIMEOUT_MS = 25_000;

// The password lives in chrome.storage.local; keep that area away from content scripts.
// (setAccessLevel is missing in old Chrome versions: the extension still works there.)
function restrictStorage() {
  try {
    const p = chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    p?.catch?.(() => {});
  } catch { /* ignore */ }
}
restrictStorage();

chrome.runtime.onInstalled.addListener((details) => {
  restrictStorage();
  if (details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
});

async function getSettings() {
  const { serverUrl, password } = await chrome.storage.local.get(['serverUrl', 'password']);
  return {
    serverUrl: L.normalizeServerUrl(serverUrl) || L.DEFAULT_SERVER,
    password: typeof password === 'string' ? password : '',
  };
}

/** Messages from the extension's own pages (options, popup), not from content scripts on YouTube. */
const fromExtensionPage = (sender) => typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

/**
 * Call the TubeScout server. Always resolves to { ok, ... } so callers never see raw exceptions.
 * `settings` = { serverUrl, password } replaces the saved ones for this one call; only the
 * options page uses it ("Test connection" on values that are not saved yet).
 */
async function callApi({ method, path, body, settings }) {
  const check = L.checkRequest(method, path, body);
  if (!check.ok) return { ok: false, kind: 'forbidden', error: check.reason };

  let serverUrl;
  let password;
  if (settings) {
    serverUrl = L.normalizeServerUrl(settings.serverUrl);
    password = typeof settings.password === 'string' ? settings.password : '';
    if (!serverUrl) return { ok: false, kind: 'forbidden', error: 'Invalid server URL.' };
  } else {
    ({ serverUrl, password } = await getSettings());
  }
  const base = { serverUrl, path: check.path.split('?')[0] };
  if (!L.isBuiltinHost(serverUrl)) {
    const granted = await chrome.permissions.contains({ origins: [L.originPattern(serverUrl)] }).catch(() => false);
    if (!granted) return { ...base, ok: false, kind: 'permission', error: `The extension is not allowed to reach ${serverUrl} yet.` };
  }

  const headers = { Accept: 'application/json' };
  const auth = L.basicAuthHeader(password);
  if (auth) headers.Authorization = auth;
  if (check.method === 'POST') headers['Content-Type'] = 'application/json'; // the server requires it (CSRF guard)

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(serverUrl + check.path, {
      method: check.method,
      headers,
      body: check.method === 'POST' ? JSON.stringify(body) : undefined,
      credentials: 'omit', // auth is the explicit header above, never cookies
      cache: 'no-store',
      redirect: 'error', // never follow the server somewhere else
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    const timedOut = ctrl.signal.aborted;
    return {
      ...base,
      ok: false,
      kind: timedOut ? 'timeout' : 'offline',
      error: timedOut ? `No answer from ${serverUrl} after ${TIMEOUT_MS / 1000}s.` : `Could not reach ${serverUrl}.`,
    };
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const serverMsg = data && typeof data.error === 'string' ? data.error : '';
    return {
      ...base,
      ok: false,
      status: res.status,
      kind: L.classifyError({ status: res.status, body: data }),
      sentPassword: Boolean(auth),
      error: serverMsg || `HTTP ${res.status}`,
    };
  }
  if (!data || typeof data !== 'object') {
    return { ...base, ok: false, status: res.status, kind: 'http', error: `${serverUrl} answered, but not with TubeScout data. Check the server URL.` };
  }
  return { ...base, ok: true, status: res.status, data };
}

const HANDLERS = {
  // Content scripts may only use the saved server; a one-off override is for extension pages.
  api: (msg, sender) => callApi({ ...msg, settings: fromExtensionPage(sender) && msg.settings && typeof msg.settings === 'object' ? msg.settings : null }),
  // Content scripts only learn the server URL (for dashboard links), never the password.
  config: async () => ({ ok: true, serverUrl: (await getSettings()).serverUrl }),
  getPrefs: async () => {
    const { collapsed } = await chrome.storage.local.get('collapsed');
    return { ok: true, collapsed: collapsed === true };
  },
  setPrefs: async (msg) => {
    await chrome.storage.local.set({ collapsed: msg.collapsed === true });
    return { ok: true };
  },
  openOptions: async () => {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension can message us (no externally_connectable), but double-check.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
  const handler = Object.hasOwn(HANDLERS, msg.type) ? HANDLERS[msg.type] : null;
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, kind: 'http', error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async response
});
