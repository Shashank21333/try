// Feature tab: Alerts. In-app feed of competitor and ranking alerts, alert settings and delivery setup
// (Telegram, Discord, Slack, generic webhook). Uses helpers from window.TubeScout (see public/app.js).
const T = window.TubeScout;
const { esc } = T;

const TYPES = {
  upload: { label: 'Upload', name: 'New uploads', desc: 'A tracked channel publishes a video or Short.' },
  breakout: { label: 'Breakout', name: 'Breakout videos', desc: 'A tracked channel’s video gains views much faster than its typical video.' },
  milestone: { label: 'Milestone', name: 'Subscriber milestones', desc: 'A tracked channel passes 1K, 10K, 50K, 100K, 500K, 1M, 5M, 10M … subscribers.' },
  rank: { label: 'Ranking', name: 'Ranking changes', desc: 'A keyword on the Rankings tab enters the top 10, enters or leaves the top 50, or moves a lot.' },
  test: { label: 'Test', name: 'Test', desc: '' },
};
const CHANNEL_NAMES = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', webhook: 'Webhook' };
const WEBHOOK_KINDS = { discord: 'Discord', slack: 'Slack', generic: 'Generic JSON webhook' };

const style = document.createElement('style');
style.textContent = `
.al-feed { list-style: none; margin: 0; padding: 0; }
.al-item { display: flex; gap: 12px; align-items: flex-start; padding: 12px 10px; border-top: 1px solid var(--border); border-left: 3px solid transparent; }
.al-item:first-child { border-top: 0; }
.al-item.unread { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.al-body { flex: 1; min-width: 0; }
.al-title { font-weight: 500; overflow-wrap: anywhere; }
.al-item.unread .al-title { font-weight: 650; }
.al-title a { text-decoration-color: var(--border); text-underline-offset: 3px; }
.al-title a:hover { text-decoration-color: currentColor; }
.al-msg { margin: 2px 0 6px; overflow-wrap: anywhere; }
.al-meta { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.al-meta .linkish { font-size: 12px; color: var(--muted); }
.al-type { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--surface-2); color: var(--text); min-width: 92px; margin-top: 1px; }
.al-type::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--bar-2); flex: none; }
.al-type.upload::before { background: var(--bar); }
.al-type.breakout::before { background: var(--accent); }
.al-type.milestone::before { background: var(--good); }
.al-type.rank::before { background: var(--warn-ink); }
.al-new { color: var(--accent); font-weight: 600; }
.al-err { color: var(--bad); }
.al-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.al-settings fieldset { border: 0; padding: 0; margin: 0 0 16px; min-width: 0; }
.al-settings legend { font-weight: 600; padding: 0; margin-bottom: 6px; }
.al-check { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; cursor: pointer; }
.al-check input { flex: none; margin: 3px 0 0; width: 16px; height: 16px; }
.al-check small { display: block; color: var(--muted); font-size: 12px; }
.al-check.disabled { opacity: .6; cursor: default; }
.al-num { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 8px 0; }
.al-num input { flex: 0 0 104px; width: 104px; }
.al-save { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.al-save button.primary { margin-left: 0; }
.al-status { list-style: none; margin: 0 0 12px; padding: 0; }
.al-status li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; padding: 8px 0; border-top: 1px solid var(--border); }
.al-status li:first-child { border-top: 0; }
.al-status .note { flex-basis: 100%; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.al-setup details { border-top: 1px solid var(--border); padding: 8px 0; }
.al-setup summary { cursor: pointer; font-weight: 600; }
.al-setup ol { margin: 8px 0 4px; padding-left: 20px; }
.al-setup li { margin: 4px 0; overflow-wrap: anywhere; }
.al-results { margin: 10px 0 0; padding: 0; list-style: none; }
.al-results li { margin: 4px 0; overflow-wrap: anywhere; }
@media (max-width: 520px) {
  .al-item { flex-direction: column; gap: 6px; padding: 12px 8px; }
}
`;
document.head.append(style);

const tabButton = () => document.querySelector('.tabs button[data-tab="alerts"]');

/** Show the unread count in the tab label, e.g. "Alerts (3)". */
function setUnread(unread) {
  const btn = tabButton();
  if (!btn) return;
  btn.textContent = unread > 0 ? `Alerts (${unread > 99 ? '99+' : unread})` : 'Alerts';
  btn.setAttribute('aria-label', unread > 0 ? `Alerts, ${unread} unread` : 'Alerts');
}

async function refreshUnread() {
  try { setUnread((await T.api('alerts', { limit: 1 })).unread); } catch { /* server unreachable: keep the old label */ }
}

const ageText = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  return T.ago(ms / 86_400_000);
};

/** Links are rebuilt from ids with the shared helpers rather than trusting a stored URL. */
function alertLink(a) {
  if (a.videoId) return T.ytVideo(a.videoId);
  if (a.channelId) return T.ytChannel(a.channelId);
  if (a.keyword) return `https://www.youtube.com/results?search_query=${encodeURIComponent(a.keyword)}`;
  return '';
}

function deliveryNote(a) {
  return (a.deliveries || []).map((d) => {
    const name = CHANNEL_NAMES[d.channel] || d.channel;
    return d.ok
      ? `<span class="pos">${esc(name)}: sent</span>`
      : `<span class="al-err" title="${esc(d.error)}">${esc(name)}: failed${d.error ? ` (${esc(d.error)})` : ''}</span>`;
  }).join('');
}

function feedItem(a) {
  const type = TYPES[a.type] ? a.type : 'test';
  const link = alertLink(a);
  const title = link
    ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" data-open="${esc(a.id)}">${esc(a.title)}</a>`
    : esc(a.title);
  const when = new Date(a.createdAt);
  return `<li class="al-item${a.read ? '' : ' unread'}" data-id="${esc(a.id)}">
    <span class="al-type ${type}">${esc(TYPES[type].label)}</span>
    <div class="al-body">
      <div class="al-title">${title}</div>
      ${a.message ? `<p class="al-msg">${esc(a.message)}</p>` : ''}
      <div class="al-meta">
        ${a.read ? '' : '<span class="al-new">New</span>'}
        <time datetime="${esc(a.createdAt)}" title="${esc(Number.isNaN(when.getTime()) ? '' : when.toLocaleString())}">${esc(ageText(a.createdAt))}</time>
        ${a.demo ? '<span title="Created from synthetic demo data">Demo data</span>' : ''}
        ${deliveryNote(a)}
        ${a.read ? '' : `<button class="linkish" data-read="${esc(a.id)}">Mark read</button>`}
      </div>
    </div>
  </li>`;
}

function feedCard(d) {
  const actions = `<div class="al-actions">
    <button class="ghost" id="al-read-all"${d.unread ? '' : ' disabled'}>Mark all read</button>
    <button class="ghost" id="al-refresh">Refresh</button>
    ${d.total ? '<button class="ghost" id="al-clear">Clear</button>' : ''}
  </div>`;
  const desc = `${d.unread ? `<b>${d.unread} unread.</b> ` : ''}Alerts are created only while TubeScout is running: when it takes the daily snapshot of channels on the <button class="linkish" data-goto="tracking">Tracking</button> tab and when it checks keywords on the <button class="linkish" data-goto="ranks">Rankings</button> tab.${d.total > d.alerts.length ? ` Showing the newest ${d.alerts.length} of ${d.total}.` : ''}`;
  const body = d.alerts.length
    ? `<ul class="al-feed">${d.alerts.map(feedItem).join('')}</ul>`
    : `<div class="state">No alerts yet. Track a few competitors on the Tracking tab and add keywords on the Rankings tab; changes show up here after the next check.</div>`;
  return T.card('Alerts', desc, body, actions);
}

const checkbox = (name, checked, label, note = '', disabled = false) => `<label class="al-check${disabled ? ' disabled' : ''}">
  <input type="checkbox" name="${esc(name)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
  <span>${esc(label)}${note ? `<small>${note}</small>` : ''}</span></label>`;

function settingsCard(s, delivery) {
  const types = ['upload', 'breakout', 'milestone', 'rank'].map((k) => checkbox(`type-${k}`, s.types[k], TYPES[k].name, esc(TYPES[k].desc))).join('');
  const tg = delivery.telegram.configured;
  const wh = delivery.webhook.configured;
  const form = `<form class="al-settings" id="al-settings" novalidate>
    <fieldset><legend>Alert me about</legend>${types}</fieldset>
    <fieldset><legend>Breakout thresholds</legend>
      <div class="al-num"><label for="al-ratio">At least</label>
        <input id="al-ratio" name="breakoutRatio" type="number" min="2" max="1000" step="0.5" value="${esc(s.breakoutRatio)}" required>
        <span>× the channel’s typical views/day</span></div>
      <div class="al-num"><label for="al-min">and at least</label>
        <input id="al-min" name="breakoutMinViewsPerDay" type="number" min="50" max="1000000000" step="1" value="${esc(s.breakoutMinViewsPerDay)}" required>
        <span>views/day</span></div>
      <p class="hint">Measured between daily snapshots (a brand-new video: views since it was published). Same idea as “Trending now” on the Tracking tab, which lists videos at 2×+ and 50+ views/day. One alert per video per 7 days.</p>
    </fieldset>
    <fieldset><legend>Ranking changes</legend>
      <div class="al-num"><label for="al-move">Also alert when a video moves</label>
        <input id="al-move" name="rankMoveThreshold" type="number" min="1" max="100" step="1" value="${esc(s.rankMoveThreshold)}" required>
        <span>or more places</span></div>
      <p class="hint">Entering the top 10 and entering or leaving the top 50 always alert (when ranking alerts are on). The first check of a keyword never alerts.</p>
    </fieldset>
    <fieldset><legend>Send alerts to</legend>
      ${checkbox('delivery-inapp', true, 'This page (in-app feed)', 'Always on.', true)}
      ${checkbox('delivery-telegram', tg && s.delivery.telegram, 'Telegram', tg ? '' : 'Not set up yet: see “Delivery” for how.', !tg)}
      ${checkbox('delivery-webhook', wh && s.delivery.webhook, wh ? `${WEBHOOK_KINDS[delivery.webhook.kind] || 'Webhook'}` : 'Discord / Slack / webhook', wh ? esc(delivery.webhook.host) : 'Not set up yet: see “Delivery” for how.', !wh)}
    </fieldset>
    <div class="al-save"><button class="primary" type="submit">Save settings</button><span id="al-save-status" class="hint" role="status" style="margin:0"></span></div>
  </form>`;
  return T.card('Alert settings', 'Choose which changes create alerts and where they are sent.', form);
}

function statusRow(name, ok, detail, note = '') {
  return `<li><span><b>${esc(name)}</b></span><span class="${ok ? 'pos' : 'muted'}">${esc(detail)}</span>${note ? `<span class="note">${note}</span>` : ''}</li>`;
}

function deliveryCard(delivery) {
  const tg = delivery.telegram;
  const wh = delivery.webhook;
  const rows = [
    statusRow('In-app feed', true, 'Always on', 'Keeps the newest 500 alerts.'),
    statusRow('Telegram', tg.configured, tg.configured ? 'Configured' : 'Not configured', tg.error ? `<span class="al-err">${esc(tg.error)}</span>` : ''),
    statusRow('Webhook', wh.configured, wh.configured ? `${WEBHOOK_KINDS[wh.kind] || 'Webhook'} · ${wh.host}` : 'Not configured', wh.error ? `<span class="al-err">${esc(wh.error)}</span>` : ''),
  ].join('');
  const anyConfigured = tg.configured || wh.configured;
  const setup = `<div class="al-setup">
    <details${tg.configured ? '' : ' open'}><summary>Set up Telegram</summary><ol>
      <li>In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>, send <code>/newbot</code> and follow the prompts. It replies with a token like <code>110201543:AAHd…</code>.</li>
      <li>Send any message to your new bot (or add the bot to a group and post there), so it can message you.</li>
      <li>Open <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> in your browser and copy the number at <code>message.chat.id</code> (group ids start with <code>-</code>).</li>
      <li>Add <code>TELEGRAM_BOT_TOKEN=…</code> and <code>TELEGRAM_CHAT_ID=…</code> to <code>.env</code> and restart TubeScout.</li>
    </ol></details>
    <details${wh.configured ? '' : ' open'}><summary>Set up Discord or Slack</summary><ol>
      <li><b>Discord:</b> in the channel’s settings (or Server Settings), open Integrations → Webhooks → New Webhook, then copy the webhook URL. You need the Manage Webhooks permission. Menu names can differ slightly between Discord versions.</li>
      <li><b>Slack:</b> at <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">api.slack.com/apps</a> create an app, open Incoming Webhooks, turn on “Activate Incoming Webhooks”, click “Add New Webhook to Workspace”, pick a channel and copy the <code>https://hooks.slack.com/services/…</code> URL.</li>
      <li><b>Anything else</b> (n8n, Zapier, Make, your own script): any URL that accepts a JSON POST receives <code>{ "text": …, "alert": { … } }</code>.</li>
      <li>Put it in <code>.env</code> as <code>ALERT_WEBHOOK_URL=…</code> and restart TubeScout. Discord and Slack URLs are detected automatically.</li>
    </ol></details>
    <p class="hint">Tokens and webhook URLs are secrets: they stay in <code>.env</code> on the server and are never shown here. Messages are plain text; Discord messages cannot ping @everyone.</p>
  </div>`;
  const test = `<div class="al-save" style="margin-top:12px">
      <button class="ghost" id="al-test"${anyConfigured ? '' : ' disabled'}>Send test message</button>
      ${anyConfigured ? '' : '<span class="hint" style="margin:0">Set up Telegram or a webhook first.</span>'}
    </div><ul class="al-results" id="al-test-results" aria-live="polite"></ul>`;
  return T.card('Delivery', 'Every alert appears in this feed. Optionally, TubeScout can also send it to a chat app.', `<ul class="al-status">${rows}</ul>${test}${setup}`);
}

/** Render the whole tab into `el`. */
async function render(el) {
  if (!el.innerHTML.trim()) el.innerHTML = T.loading('Loading alerts…');
  let d;
  try {
    d = await T.api('alerts', { limit: 100 });
  } catch (err) {
    el.innerHTML = T.errorBox(err.message);
    return;
  }
  setUnread(d.unread);
  el.innerHTML = `<div class="stack">
    ${feedCard(d)}
    <div class="grid-2">${settingsCard(d.settings, d.delivery)}${deliveryCard(d.delivery)}</div>
  </div>`;
  wire(el, d);
}

function wire(el, d) {
  const act = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try { await fn(); await render(el); } catch (err) {
      el.insertAdjacentHTML('afterbegin', T.errorBox(err.message));
      if (btn) btn.disabled = false;
    }
  };

  el.querySelector('#al-read-all')?.addEventListener('click', (e) => act(e.currentTarget, () => T.apiPost('alerts/read', { all: true })));
  el.querySelector('#al-refresh')?.addEventListener('click', (e) => act(e.currentTarget, async () => {}));
  el.querySelector('#al-clear')?.addEventListener('click', (e) => {
    if (!confirm('Delete all alerts from the feed? Alerts that were already sent will not be sent again.')) return;
    act(e.currentTarget, () => T.apiPost('alerts/clear', {}));
  });
  el.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    const tab = document.querySelector(`.tabs button[data-tab="${CSS.escape(b.dataset.goto)}"]`);
    if (tab) tab.click();
  }));

  // Mark one alert read: from its button, or when its link is opened.
  const markOne = async (id) => {
    try {
      const r = await T.apiPost('alerts/read', { ids: [id] });
      const li = el.querySelector(`.al-item[data-id="${CSS.escape(id)}"]`);
      li?.classList.remove('unread');
      li?.querySelector('.al-new')?.remove();
      li?.querySelector('[data-read]')?.remove();
      setUnread(r.unread);
      const all = el.querySelector('#al-read-all');
      if (all && !r.unread) all.disabled = true;
    } catch { /* not critical */ }
  };
  el.querySelectorAll('[data-read]').forEach((b) => b.addEventListener('click', () => markOne(b.dataset.read)));
  el.querySelectorAll('a[data-open]').forEach((a) => a.addEventListener('click', () => {
    if (a.closest('.al-item')?.classList.contains('unread')) markOne(a.dataset.open);
  }));

  const form = el.querySelector('#al-settings');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = el.querySelector('#al-save-status');
    const btn = form.querySelector('button[type=submit]');
    const val = (name) => form.elements[name];
    const body = {
      types: Object.fromEntries(['upload', 'breakout', 'milestone', 'rank'].map((k) => [k, val(`type-${k}`).checked])),
      breakoutRatio: Number(val('breakoutRatio').value),
      breakoutMinViewsPerDay: Number(val('breakoutMinViewsPerDay').value),
      rankMoveThreshold: Number(val('rankMoveThreshold').value),
      delivery: {},
    };
    // Only send toggles for channels that are set up (the others are disabled inputs).
    if (d.delivery.telegram.configured) body.delivery.telegram = val('delivery-telegram').checked;
    if (d.delivery.webhook.configured) body.delivery.webhook = val('delivery-webhook').checked;
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = 'Saving…';
    try {
      const r = await T.apiPost('alerts/settings', body);
      d.settings = r.settings;
      status.className = 'hint pos';
      status.textContent = 'Saved.';
    } catch (err) {
      status.className = 'hint neg';
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  el.querySelector('#al-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = el.querySelector('#al-test-results');
    btn.disabled = true;
    out.innerHTML = '<li class="muted">Sending…</li>';
    try {
      const r = await T.apiPost('alerts/test', {});
      out.innerHTML = r.results.length
        ? r.results.map((x) => `<li class="${x.ok ? 'pos' : 'neg'}">${esc(CHANNEL_NAMES[x.channel] || x.channel)}: ${x.ok ? 'sent. Check your chat.' : `failed: ${esc(x.error || 'unknown error')}`}</li>`).join('')
        : '<li class="muted">No delivery channel is configured.</li>';
    } catch (err) {
      out.innerHTML = `<li class="neg">${esc(err.message)}</li>`;
    } finally {
      btn.disabled = false;
    }
  });
}

T.registerTab({ id: 'alerts', label: 'Alerts', before: 'me', onShow: render });

// Unread count in the tab label: now, every 60s while the page is visible, and when it becomes visible again.
refreshUnread();
setInterval(() => { if (!document.hidden) refreshUnread(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUnread(); });
