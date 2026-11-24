// Feature tab: Rankings. Daily YouTube search rank tracking (API: /api/ranks, logic in src/ranks.js).
// Every string from the API goes through T.esc(); links through T.ytVideo / T.ytChannel.
const T = window.TubeScout;
const { esc } = T;

const STYLE = `
#rk-region { flex: 0 1 110px; text-transform: uppercase; }
#rk-region::placeholder { text-transform: none; }
.rk-quota { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.rk-meter { flex: 0 0 140px; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
.rk-meter > div { height: 100%; background: var(--bar); }
.rk-meter.full > div { background: var(--bad); }
.rk-quota .rk-push { margin-left: auto; }
.rk-info { background: var(--surface-2); padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
tr.rk-sel td { background: color-mix(in srgb, var(--bar) 9%, transparent); }
.rk-actions { display: inline-flex; gap: 6px; }
.rk-kw { font-weight: 600; }
.rk-chart { width: 100%; min-height: 200px; }
.rk-chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.rk-chart text { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
.rk-detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px 24px; margin-top: 14px; font-size: 13px; }
.rk-detail ol { margin: 4px 0 0; padding-left: 20px; }
.rk-detail li + li { margin-top: 3px; }
.rk-notes ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 12.5px; }
.rk-notes li + li { margin-top: 5px; }
#out-ranks .table-wrap { position: relative; } /* contain .rk-sr so it can't widen the page */
.rk-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
if (!document.getElementById('rk-style')) {
  const s = document.createElement('style');
  s.id = 'rk-style';
  s.textContent = STYLE;
  document.head.append(s);
}

const DAY = 86_400_000;
let root = null; // the tab's container
let data = null; // last GET /api/ranks response
let selected = T.store.get('ranks-selected');
let resizeObs = null;

const agoT = (t) => { const ms = Date.now() - t; return ms < 3_600_000 ? (ms < 60_000 ? 'just now' : `${Math.round(ms / 60_000)} min ago`) : T.ago(ms / DAY); };
const fullDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const hashPos = (p) => `#${p}`;

// ---------------------------------------------------------------- cells

/** Rank change cell. `places` > 0 means the video moved UP (a lower number is better). */
function changeCell(ch, emptyTip) {
  if (!ch) return `<td class="muted" title="${esc(emptyTip)}">—</td>`;
  const from = ch.from === null ? 'not in top 50' : hashPos(ch.from);
  const to = ch.to === null ? 'not in top 50' : hashPos(ch.to);
  const tip = `${from} → ${to} (compared with the check on ${fullDate(ch.since)})`;
  switch (ch.dir) {
    case 'up': return `<td class="pos" title="Up ${ch.places} place${ch.places === 1 ? '' : 's'}: ${esc(tip)}"><span aria-hidden="true">▲</span> ${ch.places}<span class="rk-sr"> places up</span></td>`;
    case 'down': return `<td class="neg" title="Down ${-ch.places} place${ch.places === -1 ? '' : 's'}: ${esc(tip)}"><span aria-hidden="true">▼</span> ${-ch.places}<span class="rk-sr"> places down</span></td>`;
    case 'entered': return `<td class="pos" title="Entered the top 50: ${esc(tip)}"><span aria-hidden="true">▲</span> new</td>`;
    case 'dropped': return `<td class="neg" title="Dropped out of the top 50: ${esc(tip)}"><span aria-hidden="true">▼</span> out</td>`;
    default: return `<td class="muted" title="No change: ${esc(tip)}">no change</td>`;
  }
}

function positionCell(it) {
  if (!it.checks) return '<td class="muted">not checked yet</td>';
  if (it.position === null) return '<td class="muted">not in top 50</td>';
  const more = it.positions.length > 1
    ? ` <span class="muted" title="Also at ${esc(it.positions.slice(1).map(hashPos).join(', '))}">+${it.positions.length - 1} more</span>` : '';
  return `<td><a href="${T.ytVideo(it.videoId)}" target="_blank" rel="noopener" title="${esc(it.title || '')}"><b>#${it.position}</b></a>${more}</td>`;
}

function row(it) {
  return `<tr data-id="${esc(it.id)}" class="${it.id === selected ? 'rk-sel' : ''}">
    <td class="l"><button class="linkish rk-kw rk-show" data-id="${esc(it.id)}" title="Show rank history">${esc(it.keyword)}</button></td>
    ${positionCell(it)}
    ${changeCell(it.change, it.checks ? 'Only one check so far' : 'Not checked yet')}
    ${changeCell(it.change7d, 'Needs a check from at least ~7 days earlier')}
    <td>${it.best ? `<span title="On ${esc(fullDate(it.best.t))}">#${it.best.position}</span>` : '<span class="muted">—</span>'}</td>
    <td class="l"><a href="${T.ytChannel(it.channelId)}" target="_blank" rel="noopener">${esc(it.channelTitle)}</a></td>
    <td>${it.region ? esc(it.region) : '<span class="muted">any</span>'}</td>
    <td title="${it.lastChecked ? esc(fullDate(it.lastChecked)) : ''}">${it.lastChecked ? agoT(it.lastChecked) : '<span class="muted">never</span>'}</td>
    <td><span class="rk-actions"><button class="ghost rk-check" data-id="${esc(it.id)}">Check now</button><button class="ghost rk-remove" data-id="${esc(it.id)}" aria-label="Stop tracking ${esc(it.keyword)}">Remove</button></span></td>
  </tr>`;
}

// ---------------------------------------------------------------- chart

/** Y-axis depth: zoom in when the video ranks near the top so small moves are visible. */
const axisDepth = (worst) => (worst <= 10 ? 10 : worst <= 20 ? 20 : worst <= 30 ? 30 : 50);
const ticksFor = (depth) => ({ 10: [1, 5, 10], 20: [1, 5, 10, 15, 20], 30: [1, 10, 20, 30], 50: [1, 10, 20, 30, 40, 50] }[depth]);

/**
 * SVG rank chart drawn at the container's real pixel width (so text and dots are not stretched).
 * Position #1 is at the TOP: up = better. Checks where the channel was not in the top 50 are
 * drawn as red markers on a separate lane below the axis.
 */
function chartSvg(item, width) {
  const s = item.series;
  const W = Math.max(260, Math.round(width));
  const L = 40, R = 14, TOP = 12, plotH = 150, laneGap = 26, H = TOP + plotH + laneGap + 30;
  const plotW = W - L - R;
  const found = s.filter((p) => p.position !== null);
  const depth = axisDepth(Math.max(1, ...found.map((p) => p.position)));
  const t0 = s[0].t, t1 = s.at(-1).t;
  const x = (t) => (t1 === t0 ? L + plotW / 2 : L + ((t - t0) / (t1 - t0)) * plotW);
  const y = (p) => TOP + ((p - 1) / (depth - 1)) * plotH;
  const laneY = TOP + plotH + laneGap / 2 + 4;

  const grid = ticksFor(depth).map((p) => `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--border)" stroke-width="1"/>
    <text x="${L - 6}" y="${y(p) + 4}" text-anchor="end">#${p}</text>`).join('');

  // Line segments between consecutive checks where the channel was found.
  const segs = [];
  let cur = [];
  for (const p of s) {
    if (p.position === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p);
  }
  if (cur.length) segs.push(cur);
  const lines = segs.filter((g) => g.length > 1).map((g) => `<polyline points="${g.map((p) => `${x(p.t).toFixed(1)},${y(p.position).toFixed(1)}`).join(' ')}"
    fill="none" stroke="var(--bar)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');

  // Smaller dots when checks are close together, so they don't merge into a blob.
  const gap = s.length > 1 ? plotW / (s.length - 1) : plotW;
  const r = gap < 6 ? 1.5 : gap < 18 ? 2.5 : 3.5;
  const dots = s.map((p) => {
    const tip = `<title>${esc(fullDate(p.t))}: ${p.position === null ? 'not in top 50' : `#${p.position}`}</title>`;
    if (p.position === null) {
      const cx = x(p.t);
      return `<g stroke="var(--bad)" stroke-width="2" stroke-linecap="round">${tip}<line x1="${cx - 4}" y1="${laneY - 4}" x2="${cx + 4}" y2="${laneY + 4}"/><line x1="${cx - 4}" y1="${laneY + 4}" x2="${cx + 4}" y2="${laneY - 4}"/><rect x="${cx - 6}" y="${laneY - 6}" width="12" height="12" fill="transparent" stroke="none"/></g>`;
    }
    return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.position).toFixed(1)}" r="${r}" fill="var(--bar)">${tip}</circle>`;
  }).join('');

  const lane = `<line x1="${L}" x2="${W - R}" y1="${TOP + plotH + laneGap / 2 - 6}" y2="${TOP + plotH + laneGap / 2 - 6}" stroke="var(--border)" stroke-dasharray="3 4"/>
    <text x="${L - 6}" y="${laneY + 4}" text-anchor="end">&gt;50</text>`;
  const xl = [`<text x="${L}" y="${H - 6}" text-anchor="start">${esc(T.shortDate(t0))}</text>`];
  if (t1 !== t0) xl.push(`<text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(T.shortDate(t1))}</text>`);
  if (t1 - t0 > 4 * DAY && plotW > 360) xl.push(`<text x="${L + plotW / 2}" y="${H - 6}" text-anchor="middle">${esc(T.shortDate((t0 + t1) / 2))}</text>`);

  const label = `Search position for "${item.keyword}" over ${s.length} check${s.length === 1 ? '' : 's'}; latest ${item.position === null ? 'not in top 50' : `#${item.position}`}${item.best ? `, best #${item.best.position}` : ''}. Higher on the chart is a better rank.`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${lane}${lines}${dots}${xl.join('')}</svg>`;
}

function drawChart() {
  const box = root?.querySelector('.rk-chart');
  const item = data?.items.find((i) => i.id === selected);
  if (!box || !item?.series.length) return;
  box.innerHTML = chartSvg(item, box.clientWidth || 600);
}

// ---------------------------------------------------------------- sections

function historyCard(it) {
  if (!it) return '';
  const where = `${esc(it.channelTitle)}${it.region ? ` · region ${esc(it.region)}` : ''}`;
  if (!it.checks) {
    return T.card(`Rank history: “${it.keyword}”`, `${where} · not checked yet`, '<p class="muted">The first check will appear here. Use “Check now” or wait for the daily check.</p>');
  }
  const since = `${it.checks} check${it.checks === 1 ? '' : 's'} since ${esc(T.shortDate(it.firstChecked))}`;
  const latest = it.position === null
    ? `<p>Not in the top 50 results on the last check (${esc(fullDate(it.lastChecked))}).</p>`
    : `<p><b>#${it.position}</b> with <a href="${T.ytVideo(it.videoId)}" target="_blank" rel="noopener">${esc(it.title || it.videoId)}</a>${it.positions.length > 1 ? `<br><span class="muted">The channel also appears at ${esc(it.positions.slice(1).map(hashPos).join(', '))}.</span>` : ''}</p>`;
  const top3 = it.top3.length
    ? `<ol>${it.top3.map((r) => `<li>${esc(r.title)} <span class="muted">· ${esc(r.channelTitle)}</span></li>`).join('')}</ol>`
    : '<p class="muted">No results.</p>';
  const body = `<div class="rk-chart"></div>
    <p class="hint">Higher on the chart = better rank (#1 is the top search result). Red × = the channel was not in the top 50 that day.${it.checks < 2 ? ' More points appear as daily checks run.' : ''}</p>
    <div class="rk-detail">
      <div><h3 class="sub-h">Latest check</h3>${latest}</div>
      <div><h3 class="sub-h">Top 3 results on the last check</h3>${top3}</div>
    </div>`;
  return T.card(`Rank history: “${it.keyword}”`, `${where} · ${since}`, body,
    `<button class="ghost rk-research" data-kw="${esc(it.keyword)}">Research this keyword</button>`);
}

function quotaBar(d) {
  const used = d.checksLast24h, max = d.maxChecksPerDay;
  const full = used >= max;
  const due = d.items.filter((i) => i.due).length;
  const next = full && d.nextSlotAt ? ` Next check available ${esc(fullDate(d.nextSlotAt))}.` : '';
  const auto = d.autoChecks ? '' : ' Automatic daily checks are off on this server (DISABLE_SCHEDULER=1), so use “Check now”.';
  return `<div class="rk-quota">
      <div class="rk-meter${full ? ' full' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${used}" aria-label="Rank checks used in the last 24 hours"><div style="width:${max ? Math.min(100, (used / max) * 100) : 100}%"></div></div>
      <span><b>${used} of ${max}</b> checks used in the last 24h</span>
      ${due ? `<button class="ghost rk-push" id="rk-check-due"${full ? ' disabled' : ''}>Check ${due} due now</button>` : ''}
    </div>
    <p class="hint">Each check is one YouTube search request (search.list, top 50 results) plus one cheap video-details request. The limit (RANK_MAX_CHECKS_PER_DAY) counts manual and automatic checks over a rolling 24 hours.${next}${auto}</p>`;
}

function notesCard(d) {
  const demo = d.meta?.mode === 'demo'
    ? '<li><b>Demo mode:</b> search results are synthetic and identical every day, so positions will not move. Try a demo channel such as “Gadget Lab” to see a match.</li>' : '';
  return `<section class="card rk-notes"><h2>About these positions</h2><ul>${demo}
    <li>Positions come from the YouTube Data API search (relevance order, videos only), requested with this server’s API key and no signed-in viewer. YouTube says its search may also consider a viewer’s search and watch history, so what a signed-in viewer sees can differ. Treat these numbers as a consistent day-to-day trend, not the exact position every viewer sees.</li>
    <li>“Region” is sent as the API’s <code>regionCode</code>, which limits results to videos that can be viewed in that country. It does not simulate a viewer located there.</li>
    <li>Only the top 50 video results are checked. Channels, playlists and other shelves that can appear on youtube.com are not counted.</li>
    <li>Quota: Google’s API docs currently list a default of 100 search.list calls per project per day, separate from the 10,000-unit pool used by other requests and shared with every search this app runs (for example the Keyword tab). Your project’s actual limits are shown in the Google Cloud Console.</li>
  </ul></section>`;
}

function render() {
  const out = root.querySelector('#rk-out');
  const d = data;
  if (selected && !d.items.some((i) => i.id === selected)) selected = null;
  if (!selected && d.items.length) selected = d.items[0].id;
  const table = d.items.length
    ? `<div class="table-wrap"><table><thead><tr><th class="l">Keyword</th><th>Position</th>
        <th title="Change since the previous check">vs last</th><th title="Change vs the nearest check at least ~6.5 days earlier">vs 7d</th><th>Best</th>
        <th class="l">Channel</th><th>Region</th><th>Checked</th><th></th></tr></thead>
        <tbody>${d.items.map(row).join('')}</tbody></table></div>`
    : '<div class="state">No keywords tracked yet. Add a keyword and the channel to look for above.</div>';
  out.innerHTML = `${T.card('Search rankings', `${d.items.length} tracked · lower number = better · ▲ green = moved up, ▼ red = moved down`, `${quotaBar(d)}${table}`)}
    <div id="rk-history">${historyCard(d.items.find((i) => i.id === selected))}</div>
    ${notesCard(d)}`;
  drawChart();
}

function selectItem(id) {
  selected = id;
  T.store.set('ranks-selected', id);
  root.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('rk-sel', tr.dataset.id === id));
  root.querySelector('#rk-history').innerHTML = historyCard(data.items.find((i) => i.id === id));
  drawChart();
}

// ---------------------------------------------------------------- data + events

function message(html) { root.querySelector('#rk-msg').innerHTML = html; }
const info = (text) => `<div class="rk-info" role="status">${esc(text)}</div>`;

async function load({ quiet = false } = {}) {
  const out = root.querySelector('#rk-out');
  if (!quiet || !data) out.innerHTML = T.loading('Loading tracked rankings…');
  try {
    data = await T.api('ranks', {});
    render();
  } catch (err) {
    out.innerHTML = T.errorBox(err.message);
  }
}

async function withButton(btn, busyText, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try { await fn(); } catch (err) { message(T.errorBox(err.message)); } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

function formHtml() {
  const link = T.deepLink.get('tab') === 'ranks' ? T.deepLink : null; // prefill only; never auto-submits (would spend quota)
  const val = (k, fallback = '') => esc(link?.get(k) || fallback);
  return `<form class="search" id="rk-form" novalidate>
      <label for="rk-keyword">Track where a channel ranks in YouTube search for a keyword</label>
      <div class="row">
        <input id="rk-keyword" placeholder="Keyword, e.g. budget phone review" maxlength="100" autocomplete="off" value="${val('keyword')}">
        <input id="rk-channel" placeholder="Channel: @handle, URL or channel ID" autocomplete="off" value="${val('channel', T.store.get('ranks-channel') || '')}">
        <input id="rk-region" placeholder="Region" maxlength="2" autocomplete="off" aria-label="Region: optional 2-letter country code" value="${val('region')}">
        <button type="submit" class="primary">Track rank</button>
      </div>
      <p class="hint">Adding a keyword checks it right away; after that TubeScout re-checks it about once a day while the server is running, and records where the channel’s videos appear in the top 50 results.</p>
    </form>
    <div id="rk-msg" aria-live="polite"></div>
    <div id="rk-out"></div>`;
}

function wire() {
  const form = root.querySelector('#rk-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const keyword = form.querySelector('#rk-keyword').value.trim();
    const channel = form.querySelector('#rk-channel').value.trim();
    const region = form.querySelector('#rk-region').value.trim();
    if (!keyword || !channel) { message(T.errorBox('Enter a keyword and the channel to look for.')); return; }
    if (region && !/^[A-Za-z]{2}$/.test(region)) { message(T.errorBox('Region must be a 2-letter country code such as US, GB or IN (or leave it empty).')); return; }
    T.store.set('ranks-channel', channel);
    message('');
    await withButton(form.querySelector('button[type=submit]'), 'Checking…', async () => {
      const res = await T.apiPost('ranks', { keyword, channel, region });
      form.querySelector('#rk-keyword').value = '';
      selected = res.item.id;
      T.store.set('ranks-selected', selected);
      const pos = res.item.position;
      message(res.checkError
        ? info(`Added “${res.item.keyword}”, but the first check did not run: ${res.checkError}`)
        : info(`Added “${res.item.keyword}”: ${pos === null ? `${res.item.channelTitle} is not in the top 50 results right now` : `${res.item.channelTitle} ranks #${pos}`}.`));
      await load({ quiet: true });
    });
  });

  root.querySelector('#rk-region').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  root.querySelector('#rk-out').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) {
      // Clicking anywhere on a row (except links) selects it.
      const tr = e.target.closest('tr[data-id]');
      if (tr && !e.target.closest('a')) selectItem(tr.dataset.id);
      return;
    }
    if (b.classList.contains('rk-show')) selectItem(b.dataset.id);
    else if (b.classList.contains('rk-research')) T.goToKeyword(b.dataset.kw);
    else if (b.classList.contains('rk-check')) {
      message('');
      await withButton(b, 'Checking…', async () => {
        const res = await T.apiPost('ranks/check', { id: b.dataset.id });
        if (!res.checked) message(info(res.message));
        selected = b.dataset.id;
        await load({ quiet: true });
      });
    } else if (b.classList.contains('rk-remove')) {
      const it = data.items.find((i) => i.id === b.dataset.id);
      if (!confirm(`Stop tracking “${it?.keyword}” and delete its rank history?`)) return;
      message('');
      await withButton(b, 'Removing…', async () => {
        await T.apiPost('ranks/remove', { id: b.dataset.id });
        await load({ quiet: true });
      });
    } else if (b.id === 'rk-check-due') {
      message('');
      await withButton(b, 'Checking…', async () => {
        const res = await T.apiPost('ranks/check', {});
        const ok = res.results.filter((r) => !r.error).length;
        const failed = res.results.find((r) => r.error);
        message(info(`Checked ${ok} of ${res.due} due keyword${res.due === 1 ? '' : 's'}.${failed ? ` Stopped: ${failed.error}` : ''}`));
        await load({ quiet: true });
      });
    }
  });

  // Redraw the chart at the new width (the SVG is drawn in real pixels so text stays readable).
  let last = 0;
  resizeObs = new ResizeObserver(() => {
    const w = root.querySelector('.rk-chart')?.clientWidth || 0;
    if (Math.abs(w - last) > 4) { last = w; drawChart(); }
  });
  resizeObs.observe(root);
}

T.registerTab({
  id: 'ranks',
  label: 'Rankings',
  before: 'tracking',
  onShow(el) {
    if (root !== el) {
      root = el;
      el.innerHTML = formHtml();
      wire();
    }
    return load({ quiet: true });
  },
});
