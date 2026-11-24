// Options page: server URL + optional password, with a connection test.
'use strict';
(() => {
  const L = globalThis.TubeScoutLib;
  const { checkConnection } = globalThis.TubeScoutStatus;
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const serverInput = $('server');
  const passwordInput = $('password');
  const out = $('status');
  const saved = $('saved');

  async function loadSettings() {
    const { serverUrl, password } = await chrome.storage.local.get(['serverUrl', 'password']);
    serverInput.value = L.normalizeServerUrl(serverUrl) || L.DEFAULT_SERVER;
    passwordInput.value = typeof password === 'string' ? password : '';
  }

  function fail(text) {
    out.className = 'status bad';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = text;
    out.replaceChildren(t);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const serverUrl = L.normalizeServerUrl(serverInput.value);
    if (!serverUrl) {
      fail('Enter a server URL starting with http:// or https://, e.g. http://localhost:3000');
      serverInput.focus();
      return;
    }
    // chrome.permissions.request must run inside the click, before any await.
    const permission = L.isBuiltinHost(serverUrl)
      ? Promise.resolve(true)
      : chrome.permissions.request({ origins: [L.originPattern(serverUrl)] }).catch(() => false);
    save(serverUrl, permission);
  });

  async function save(serverUrl, permission) {
    if (!(await permission)) {
      fail(`Chrome did not grant access to ${new URL(serverUrl).host}, so the extension cannot reach it. Settings not saved.`);
      return;
    }
    const { serverUrl: previous } = await chrome.storage.local.get('serverUrl');
    await chrome.storage.local.set({ serverUrl, password: passwordInput.value });
    serverInput.value = serverUrl;
    // Drop access to a previous non-local server we no longer use.
    const prev = L.normalizeServerUrl(previous);
    if (prev && !L.isBuiltinHost(prev) && L.originPattern(prev) !== L.originPattern(serverUrl)) {
      chrome.permissions.remove({ origins: [L.originPattern(prev)] }).catch(() => {});
    }
    saved.textContent = 'Saved.';
    setTimeout(() => { saved.textContent = ''; }, 2000);
    await checkConnection(out);
  }

  $('test').addEventListener('click', () => checkConnection(out));

  loadSettings().then(() => checkConnection(out));
})();
