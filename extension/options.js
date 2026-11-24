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
  let stored = { serverUrl: L.DEFAULT_SERVER, password: '' }; // what the panel on YouTube uses

  async function loadSettings() {
    const { serverUrl, password } = await chrome.storage.local.get(['serverUrl', 'password']);
    stored = { serverUrl: L.normalizeServerUrl(serverUrl) || L.DEFAULT_SERVER, password: typeof password === 'string' ? password : '' };
    serverInput.value = stored.serverUrl;
    passwordInput.value = stored.password;
  }

  /** The form's server URL, or null after showing why it is invalid. */
  function formServerUrl() {
    const serverUrl = L.normalizeServerUrl(serverInput.value);
    if (!serverUrl) {
      fail('Enter a server URL starting with http:// or https://, e.g. http://localhost:3000');
      serverInput.focus();
    }
    return serverUrl;
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
    const serverUrl = formServerUrl();
    if (!serverUrl) return;
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
    stored = { serverUrl, password: passwordInput.value };
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

  // Test what is typed in the form, saved or not (the worker accepts this override only from
  // extension pages). A host Chrome has not granted yet still needs Save first.
  const testBtn = $('test');
  testBtn.addEventListener('click', async () => {
    const serverUrl = formServerUrl();
    if (!serverUrl) return;
    const settings = { serverUrl, password: passwordInput.value };
    testBtn.disabled = true;
    saved.textContent = '';
    const res = await checkConnection(out, { settings }).finally(() => { testBtn.disabled = false; });
    if (serverUrl !== stored.serverUrl || settings.password !== stored.password) {
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = res && res.ok
        ? 'Tested the values above. They are not saved yet: click Save to use them on YouTube.'
        : 'Tested the values above (not saved). The saved settings are unchanged.';
      out.append(note);
    }
  });

  loadSettings().then(() => checkConnection(out));
})();
