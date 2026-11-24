// Toolbar popup: connection status, "Open dashboard" and a link to the settings.
'use strict';
(() => {
  const L = globalThis.TubeScoutLib;
  const { checkConnection, send } = globalThis.TubeScoutStatus;
  const $ = (id) => document.getElementById(id);
  let serverUrl = L.DEFAULT_SERVER;

  $('open').addEventListener('click', () => {
    chrome.tabs.create({ url: L.dashboardUrl(serverUrl) });
    window.close();
  });
  $('options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  (async () => {
    const cfg = await send({ type: 'config' });
    if (cfg && cfg.ok) serverUrl = cfg.serverUrl;
    $('server').textContent = serverUrl;
    await checkConnection($('status'), { detailed: false });
  })();
})();
