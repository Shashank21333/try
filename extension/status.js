// Connection check shared by the options page and the popup. Builds DOM with
// textContent only. The request itself goes through the service worker.
(function (root) {
  'use strict';
  const L = root.TubeScoutLib;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const INTEGRATIONS = {
    trends: 'Google Trends (SerpAPI)',
    volume: 'Search volume (Keywords Everywhere)',
    oauth: 'My channel (Google sign-in)',
    ai: 'AI Studio',
    // `alerts` is true only when Telegram or a webhook is configured; the in-app alert feed always works.
    alerts: 'Alert delivery (Telegram / Discord / Slack / webhook)',
  };

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(L.messagingFailure);

  /** Message for a failed request, matching the panel's error states. */
  function describeFailure(res) {
    const server = res.serverUrl || L.DEFAULT_SERVER;
    switch (res.kind) {
      case 'offline': return [`Could not reach ${server}.`, 'Start TubeScout in its folder with: npm start'];
      case 'auth': return [res.sentPassword ? 'The server rejected this password.' : 'This server needs a password (APP_PASSWORD).', 'Enter it above and save.'];
      case 'permission': return [`The extension may not reach ${server} yet.`, 'Click Save and allow access when Chrome asks.'];
      case 'missing': return ['That server has no /api/status endpoint.', 'Is this URL a TubeScout server? If so, update it (git pull) and restart.'];
      case 'timeout': return [res.error || 'The server did not answer in time.'];
      default: return [res.error || 'Something went wrong.'];
    }
  }

  /**
   * Check /api/status (and whether /api/video exists) and render the result into `out`.
   * `settings` ({ serverUrl, password }) tests those values instead of the saved ones.
   * Returns the /api/status response.
   */
  async function checkConnection(out, { detailed = true, settings } = {}) {
    out.className = 'status';
    out.replaceChildren(el('div', 'muted', 'Checking connection…'));
    const res = await send({ type: 'api', method: 'GET', path: '/api/status', settings });
    out.replaceChildren();
    if (!res || !res.ok) {
      out.classList.add('bad');
      const [first, ...rest] = describeFailure(res || {});
      out.append(el('div', 'title', 'Not connected'), el('div', '', first));
      for (const line of rest) out.append(el('div', 'muted', line));
      return res;
    }
    const st = res.data || {};
    out.classList.add('ok');
    const live = st.mode === 'live';
    out.append(el('div', 'title', `Connected to ${new URL(res.serverUrl).host}`));
    out.append(el('div', '', live
      ? 'Live mode: real data from the YouTube Data API.'
      : 'Demo mode: video and channel numbers are synthetic. Add YOUTUBE_API_KEY on the server for real data.'));
    if (!live) out.lastChild.className = 'banner';
    if (detailed) {
      if (typeof st.quotaUsedSinceStart === 'number') {
        out.append(el('div', 'muted', `YouTube API units used since the server started: ${st.quotaUsedSinceStart}`));
      }
      if (typeof st.searchCallsSinceStart === 'number') {
        // search.list has its own daily bucket (about 100 calls by default), separate from the 10,000 units.
        out.append(el('div', 'muted', `YouTube search calls since the server started: ${st.searchCallsSinceStart}`));
      }
      const integ = st.integrations && typeof st.integrations === 'object' ? st.integrations : {};
      const ul = el('ul');
      for (const [k, label] of Object.entries(INTEGRATIONS)) {
        if (!(k in integ)) continue;
        const li = el('li', '', `${label}: `);
        li.append(el('span', integ[k] ? 'pos' : 'muted', integ[k] ? 'on' : 'off'));
        ul.append(li);
      }
      if (ul.childElementCount) out.append(ul);
      // An unknown route answers 404 "Not found"; a missing id answers 400, so 400 means it exists.
      const probe = await send({ type: 'api', method: 'GET', path: '/api/video', settings });
      if (probe && probe.kind === 'missing') {
        out.append(el('div', 'banner', 'This server has no /api/video endpoint yet, so the video panel will not work. Update TubeScout (git pull) and restart it.'));
      }
    }
    return res;
  }

  root.TubeScoutStatus = { checkConnection, send };
})(globalThis);
