// TubeScout content script for www.youtube.com.
//
// Shows a compact panel with data from the user's own TubeScout server on
// watch/Shorts pages (video), channel pages and search results (keyword).
// - All network calls go through the service worker (chrome.runtime.sendMessage).
// - The UI lives in a closed Shadow DOM, so YouTube's CSS cannot restyle it and
//   page scripts cannot read it.
// - The DOM is built with createElement/textContent only: never innerHTML with
//   server or YouTube data (YouTube also enforces Trusted Types).
(() => {
  'use strict';

  const L = globalThis.TubeScoutLib;
  if (!L || globalThis.__tubescoutContentLoaded) return;
  globalThis.__tubescoutContentLoaded = true;

  const HOST_TAG = 'tubescout-panel';
  const CACHE_TTL_MS = 5 * 60_000;
  const POLL_MS = 1000;

  // A reloaded extension leaves its old panel behind: there must only ever be one.
  for (const old of document.querySelectorAll(HOST_TAG)) old.remove();

  const host = document.createElement(HOST_TAG);
  const shadow = host.attachShadow({ mode: 'closed' });
  // Constructable stylesheets are CSSOM, so a strict page CSP can't block them; <style> is the fallback.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS());
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS();
    shadow.append(style);
  }
  const panel = h('section', { class: 'panel', role: 'complementary', 'aria-label': 'TubeScout' });
  shadow.append(panel);

  const state = {
    href: '',
    page: { type: null },
    key: '',
    gen: 0, // bumps on every navigation/reload so stale responses are dropped
    collapsed: false,
    loadedKey: '', // which page key the body currently shows data for
    keyword: '', // optional target keyword for the video SEO score
  };
  const cache = new Map();
  let statusCache = null;
  let timer = null;
  let themeObserver = null;

  // ---------- tiny DOM helpers (no innerHTML anywhere) ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false || c === '') continue;
      el.append(c instanceof Node ? c : String(c)); // strings become text nodes
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    chevron: 'M6 9l6 6 6-6',
    settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', `ic ic-${name}`);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name]);
    svg.append(p);
    return svg;
  }

  const isHttpUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
  /** External link (dashboard): new tab, no referrer. */
  const extLink = (text, href, cls) => (isHttpUrl(href)
    ? h('a', { class: cls || 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, text, icon('external'))
    : null);
  /** YouTube link: same tab, like any other YouTube link. */
  const ytLink = (text, href, cls) => h('a', { class: cls || 'link', href }, text);
  const ytWatch = (id) => (L.VIDEO_ID_RE.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null);
  const ytSearch = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

  function kpi(label, value, note, tone) {
    return h('div', { class: 'kpi' },
      h('div', { class: 'k-label', text: label }),
      h('div', { class: `k-value ${tone || ''}`, text: value }),
      note ? h('div', { class: 'k-note', text: note }) : null);
  }

  const section = (title, ...children) => h('div', { class: 'sec' }, h('div', { class: 'sec-title', text: title }), ...children);

  // ---------- messaging ----------

  async function send(msg) {
    if (!chrome.runtime?.id) { teardown(); throw new Error('TubeScout was updated or removed. Reload the page.'); }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (/context invalidated/i.test(String(e && e.message))) teardown();
      throw e;
    }
  }

  async function api(method, path, body) {
    const cacheable = method === 'GET';
    const hit = cacheable && cache.get(path);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.res;
    let res;
    try {
      res = await send({ type: 'api', method, path, body });
    } catch (e) {
      res = { ok: false, kind: 'extension', error: String((e && e.message) || e) };
    }
    if (!res || typeof res !== 'object') res = { ok: false, kind: 'extension', error: 'No answer from the extension.' };
    if (cacheable && res.ok) cache.set(path, { t: Date.now(), res });
    return res;
  }

  /** /api/status, cached: tells us demo vs live and whether paid integrations are on. */
  async function serverStatus() {
    if (statusCache && Date.now() - statusCache.t < CACHE_TTL_MS) return statusCache.res;
    const res = await api('GET', '/api/status');
    if (res.ok) statusCache = { t: Date.now(), res };
    return res;
  }

  // ---------- layout: inline in the watch sidebar when possible, else floating ----------

  function inlineTarget() {
    if (state.page.type !== 'video' || state.page.isShort) return null;
    const el = document.querySelector('ytd-watch-flexy #secondary-inner') || document.querySelector('#secondary-inner');
    if (!el || !el.getClientRects().length || el.getBoundingClientRect().width < 280) return null; // hidden or one-column layout
    return el;
  }

  function place() {
    if (!state.page.type) { host.remove(); return; }
    const target = inlineTarget();
    host.toggleAttribute('data-floating', !target);
    const parent = target || document.body;
    if (parent && host.parentNode !== parent) parent.prepend(host);
  }

  function syncTheme() {
    host.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));
  }

  // ---------- panel chrome ----------

  const TYPE_LABEL = { video: 'Video', channel: 'Channel', search: 'Keyword' };

  function header() {
    const toggle = h('button', {
      class: 'icon-btn toggle', type: 'button',
      'aria-expanded': String(!state.collapsed),
      'aria-label': state.collapsed ? 'Expand TubeScout panel' : 'Collapse TubeScout panel',
      title: state.collapsed ? 'Expand' : 'Collapse',
      onclick: (e) => { e.stopPropagation(); setCollapsed(!state.collapsed); },
    }, icon('chevron'));
    const settings = h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'TubeScout settings', title: 'Settings',
      onclick: (e) => { e.stopPropagation(); openOptions(); },
    }, icon('settings'));
    return h('header', { class: 'head', onclick: () => setCollapsed(!state.collapsed) },
      h('span', { class: 'logo', 'aria-hidden': 'true', text: 'TS' }),
      h('span', { class: 'brand', text: 'TubeScout' }),
      h('span', { class: 'kind', text: TYPE_LABEL[state.page.type] || '' }),
      h('span', { class: 'spacer' }),
      settings,
      toggle);
  }

  function openOptions() {
    send({ type: 'openOptions' }).catch(() => {});
  }

  function setCollapsed(c) {
    state.collapsed = c;
    send({ type: 'setPrefs', collapsed: c }).catch(() => {});
    render();
  }

  /** Re-render the frame; load data for the current page if the body is open and not loaded yet. */
  function render(body) {
    panel.replaceChildren(header());
    panel.classList.toggle('collapsed', state.collapsed);
    if (state.collapsed) return; // collapsed panels don't fetch anything (saves API quota)
    if (body) { panel.append(h('div', { class: 'body' }, body)); return; }
    if (state.loadedKey === state.key && state.lastBody) { panel.append(h('div', { class: 'body' }, state.lastBody)); return; }
    load();
  }

  function show(body, key) {
    if (key !== state.key) return;
    state.loadedKey = key;
    state.lastBody = body;
    render(body);
  }

  const loading = (text) => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), text || 'Loading from TubeScout…');

  function demoBanner(meta) {
    return meta && meta.mode === 'demo'
      ? h('div', { class: 'banner', role: 'note' },
        h('b', { text: 'Demo mode: ' }),
        'these numbers are synthetic, not this page’s real stats. Add YOUTUBE_API_KEY to your TubeScout server for real data.')
      : null;
  }

  function errorView(res, retry) {
    const server = res.serverUrl || L.DEFAULT_SERVER;
    const buttons = h('div', { class: 'actions' },
      retry ? h('button', { class: 'btn', type: 'button', onclick: retry, text: 'Retry' }) : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: openOptions, text: 'Settings' }));
    let title;
    let lines;
    switch (res.kind) {
      case 'offline':
        title = 'TubeScout server not running';
        lines = [
          h('p', {}, 'Could not reach ', h('code', { text: server }), '. Start it in your TubeScout folder:'),
          h('pre', { class: 'cmd', text: 'npm start' }),
          h('p', { class: 'muted', text: 'Running it elsewhere? Set the server URL in Settings.' }),
        ];
        break;
      case 'auth':
        title = res.sentPassword ? 'Wrong password' : 'Password required';
        lines = [h('p', {
          text: res.sentPassword
            ? 'Your TubeScout server rejected the saved password. Update it in Settings (it must match APP_PASSWORD).'
            : 'Your TubeScout server has APP_PASSWORD set. Enter that password in Settings.',
        })];
        break;
      case 'missing':
        title = 'Server needs an update';
        lines = [h('p', {}, 'Your TubeScout server has no ', h('code', { text: res.path || 'endpoint' }),
          ' endpoint yet. Update it (git pull) and restart it (npm start).')];
        break;
      case 'permission':
        title = 'Permission needed';
        lines = [h('p', { text: `Open Settings and click Save to let the extension reach ${server}.` })];
        break;
      case 'timeout':
        title = 'Server is taking too long';
        lines = [h('p', { text: res.error || 'No answer in time.' })];
        break;
      default:
        title = 'TubeScout could not load this';
        lines = [h('p', { text: res.error || 'Something went wrong.' })];
    }
    return h('div', { class: 'error', role: 'alert' }, h('div', { class: 'err-title', text: title }), lines, buttons);
  }

  function trackButton(channel) {
    if (!channel) return null;
    const btn = h('button', { class: 'btn', type: 'button', text: 'Track channel', title: 'Take a daily snapshot of this channel on your TubeScout server' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Tracking…';
      const res = await api('POST', '/api/tracked', { channel });
      if (res.ok) {
        btn.textContent = res.data && res.data.added === false ? 'Already tracked ✓' : 'Tracked daily ✓';
        btn.classList.add('done');
      } else {
        btn.disabled = false;
        btn.textContent = 'Track channel';
        if (btn.nextElementSibling?.classList.contains('inline-err')) btn.nextElementSibling.remove();
        btn.after(h('div', { class: 'inline-err', role: 'alert', text: res.kind === 'auth' ? 'Password required: open Settings.' : (res.error || 'Could not track this channel.') }));
      }
    });
    return btn;
  }

  function footer(res, source) {
    return h('div', { class: 'foot' }, `${source} · via `, extLink(new URL(res.serverUrl).host, L.dashboardUrl(res.serverUrl), 'foot-link'));
  }

  // ---------- page views ----------

  async function load() {
    const gen = ++state.gen;
    const key = state.key;
    const page = state.page;
    panel.append(h('div', { class: 'body' }, loading()));
    let body;
    try {
      if (page.type === 'video') body = await videoView(page);
      else if (page.type === 'channel') body = await channelView(page);
      else if (page.type === 'search') body = await keywordView(page);
    } catch (e) {
      body = errorView({ kind: 'extension', error: String((e && e.message) || e) }, retry);
    }
    if (gen !== state.gen || !body) return; // navigated away meanwhile
    show(body, key);
  }

  function retry() {
    cache.clear();
    statusCache = null;
    state.loadedKey = '';
    render();
  }

  async function videoView(page) {
    const res = await api('GET', L.apiPath('/api/video', { id: page.videoId, keyword: state.keyword }));
    if (!res.ok) return errorView(res, retry);
    const d = res.data;
    const v = d.video || {};
    const ch = d.channel || {};
    const seo = d.seo || {};
    const isDemo = d.meta && d.meta.mode === 'demo';
    const score = typeof d.outlierScore === 'number' ? d.outlierScore : null;

    const kpis = h('div', { class: 'kpis' },
      kpi('Views / day', L.formatCompact(v.viewsPerDay), [L.formatCompact(v.views), ' views', v.ageDays != null ? ` · ${L.formatAge(v.ageDays)}` : ''].join('')),
      kpi('Outlier', L.formatMultiplier(score), `vs channel median${v.isShort ? ' (Shorts)' : ''}`, score === null ? '' : score >= 2 ? 'pos' : score < 0.5 ? 'neg' : ''),
      kpi('Engagement', L.formatPercent(v.engagementRate, 2), typeof ch.avgEngagement === 'number' ? `channel avg ${L.formatPercent(ch.avgEngagement, 2)}` : 'likes + comments / views'),
      kpi('SEO score', typeof seo.score === 'number' ? `${seo.score}/100` : '–', seo.grade ? `grade ${seo.grade}` : 'not available',
        seo.score >= 80 ? 'pos' : seo.score < 50 ? 'neg' : ''));

    const failed = L.topFailedChecks(seo.checks, 3);
    const seoList = Array.isArray(seo.checks)
      ? (failed.length
        ? h('ol', { class: 'checks' }, failed.map((c) => h('li', {},
          h('div', { class: 'c-head' },
            h('span', { class: 'c-label', text: String(c.label || c.id || 'Check') }),
            h('span', { class: `pill ${c.kind === 'rule' ? 'rule' : ''}`, text: c.kind === 'rule' ? 'YouTube rule' : 'heuristic' })),
          (c.fix || c.detail) ? h('div', { class: 'c-detail', text: String(c.fix || c.detail) }) : null)))
        : h('p', { class: 'muted', text: 'No failed SEO checks.' }))
      : h('p', { class: 'muted', text: 'This server version does not return SEO checks.' });

    // Optional target keyword: re-scores keyword placement in title/description/tags.
    const kwInput = h('input', { type: 'search', class: 'input', placeholder: 'Target keyword (optional)', 'aria-label': 'Target keyword', maxlength: '100', value: state.keyword });
    const kwForm = h('form', { class: 'kw-form', onsubmit: (e) => { e.preventDefault(); state.keyword = kwInput.value.trim(); state.loadedKey = ''; render(); } },
      kwInput, h('button', { class: 'btn', type: 'submit', text: 'Re-score' }));
    // Keep YouTube's keyboard shortcuts (k, j, l, f...) from firing while typing here.
    for (const t of ['keydown', 'keyup', 'keypress']) kwInput.addEventListener(t, (e) => e.stopPropagation());

    const tags = Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string') : [];
    const tagBlock = tags.length
      ? h('div', {},
        h('div', { class: 'chips' }, tags.slice(0, 24).map((t) => h('span', { class: 'chip', text: t })),
          tags.length > 24 ? h('span', { class: 'chip more', text: `+${tags.length - 24} more` }) : null),
        copyButton(tags))
      : h('p', { class: 'muted', text: 'This video has no tags.' });

    const server = res.serverUrl;
    return h('div', {},
      demoBanner(d.meta),
      h('div', { class: 'title-line', title: v.title || '', text: v.title || '' }),
      kpis,
      h('p', { class: 'hint', text: 'Outlier = views ÷ the channel’s recent median (same format). SEO score = TubeScout’s heuristic checklist, not a YouTube ranking factor.' }),
      section(`SEO${seo.grade ? ` · grade ${seo.grade}` : ''} · fix first`, seoList, kwForm),
      section(`Tags (${tags.length})`, tagBlock),
      h('div', { class: 'actions' },
        trackButton(v.channelId),
        extLink('Full audit', L.dashboardUrl(server, { tab: 'audit', video: page.videoId })),
        extLink('Open dashboard', L.dashboardUrl(server), 'btn ghost')),
      footer(res, isDemo ? 'Synthetic demo data' : 'YouTube Data API (a few quota units)'));
  }

  function copyButton(tags) {
    const text = tags.join(', ');
    const btn = h('button', { class: 'btn small', type: 'button', text: 'Copy tags' });
    btn.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back below */ }
      if (!ok) {
        const ta = h('textarea', { class: 'offscreen', 'aria-hidden': 'true' });
        ta.value = text;
        shadow.append(ta);
        ta.select();
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
      }
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy tags'; }, 1600);
    });
    return btn;
  }

  async function channelView(page) {
    const res = await api('GET', L.apiPath('/api/channel', { q: page.channel, max: 50, tz: new Date().getTimezoneOffset() }));
    if (!res.ok) return errorView(res, retry);
    const d = res.data;
    const c = d.channel || {};
    const isDemo = d.meta && d.meta.mode === 'demo';
    const outliers = Array.isArray(d.outliers) ? d.outliers.slice(0, 3) : [];
    const upw = typeof c.uploadsPerWeek === 'number' ? (c.uploadsPerWeek >= 10 ? Math.round(c.uploadsPerWeek) : c.uploadsPerWeek.toFixed(1)) : '–';

    const list = outliers.length
      ? h('ol', { class: 'outliers' }, outliers.map((o) => {
        const href = ytWatch(o.id);
        return h('li', {},
          href ? ytLink(String(o.title || o.id), href, 'link clamp') : h('span', { class: 'clamp', text: String(o.title || '') }),
          h('div', { class: 'o-meta' },
            h('span', { class: 'score pos', text: L.formatMultiplier(o.outlierScore) }),
            ` · ${L.formatCompact(o.views)} views`, o.ageDays != null ? ` · ${L.formatAge(o.ageDays)}` : ''));
      }))
      : h('p', { class: 'muted', text: 'No outliers in the recent uploads.' });

    const server = res.serverUrl;
    return h('div', {},
      demoBanner(d.meta),
      h('div', { class: 'title-line' }, String(c.title || page.channel), c.handle ? h('span', { class: 'muted', text: ` ${c.handle}` }) : null),
      h('div', { class: 'kpis' },
        kpi('Subscribers', c.subscribers == null ? 'hidden' : L.formatCompact(c.subscribers)),
        kpi('Median views', L.formatCompact(c.medianViews), 'per recent upload'),
        kpi('Uploads / week', String(upw)),
        kpi('Engagement', L.formatPercent(c.avgEngagement, 2), 'likes + comments / views')),
      typeof c.sampleSize === 'number' ? h('p', { class: 'hint', text: `Based on the last ${c.sampleSize} uploads.` }) : null,
      section('Top outliers', list),
      h('div', { class: 'actions' },
        trackButton(c.id || page.channel),
        extLink('Open in TubeScout', L.dashboardUrl(server, { tab: 'channel', q: c.id || page.channel })),
        extLink('Open dashboard', L.dashboardUrl(server), 'btn ghost')),
      footer(res, isDemo ? 'Synthetic demo data' : 'YouTube Data API (a few quota units)'));
  }

  async function keywordView(page) {
    // /api/demand also calls paid add-ons (SerpAPI Trends, Keywords Everywhere) when the
    // server has them configured, so in that case only load on an explicit click.
    const cachedPath = demandPath(page.query);
    if (!cache.has(cachedPath) && !state.demandConfirmed) {
      const st = await serverStatus();
      if (!st.ok) return errorView(st, retry);
      const integ = (st.data && st.data.integrations) || {};
      if (integ.trends || integ.volume) {
        const paid = [integ.trends ? 'SerpAPI (Google Trends)' : null, integ.volume ? 'Keywords Everywhere' : null].filter(Boolean).join(' and ');
        return h('div', {},
          h('p', {}, 'Search demand for ', h('b', { text: `“${page.query}”` })),
          h('p', { class: 'muted', text: `Your server also queries ${paid} for each keyword, which uses your credits there, so this doesn’t load automatically.` }),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', text: 'Load keyword data', onclick: () => { state.demandConfirmed = true; state.loadedKey = ''; render(); } })));
      }
    }
    const res = await api('GET', cachedPath);
    if (!res.ok) return errorView(res, retry);
    const d = res.data;
    const ac = d.autocomplete || {};
    const strength = typeof ac.strength === 'number' ? Math.max(0, Math.min(100, ac.strength)) : 0;
    const ideas = Array.isArray(d.ideas) ? d.ideas.slice(0, 8) : [];

    const gauge = ac.error
      ? h('p', { class: 'inline-err', text: L.strengthExplanation(ac) })
      : h('div', { class: 'gauge' },
        h('div', { class: 'g-head' }, h('span', { class: 'k-label', text: 'Autocomplete strength' }), h('span', { class: 'g-value', text: `${strength}/100` })),
        h('div', { class: 'track' }, fillBar(strength)),
        h('p', { class: 'g-note', text: L.strengthExplanation(ac) }));

    // Tag questions only when it tells something (a "how to …" seed makes every idea a question).
    const markQuestions = ideas.some((i) => i.type !== 'question');
    const ideaList = Array.isArray(d.ideas)
      ? (ideas.length
        ? h('ol', { class: 'ideas' }, ideas.map((i) => h('li', {},
          ytLink(String(i.keyword), ytSearch(String(i.keyword)), 'link'),
          markQuestions && i.type === 'question' ? h('span', { class: 'pill', text: 'question' }) : null,
          h('span', { class: 'i-meta', text: `${i.appearances}× · best #${i.bestPosition}` }))))
        : h('p', { class: 'muted', text: 'YouTube suggested no related searches.' }))
      : h('p', { class: 'inline-err', text: `Keyword ideas unavailable${d.ideas && d.ideas.error ? `: ${d.ideas.error}` : '.'}` });

    const server = res.serverUrl;
    return h('div', {},
      h('div', { class: 'title-line', text: `“${d.keyword || page.query}”` }),
      gauge,
      section('Keyword ideas', ideaList,
        Array.isArray(d.ideas) && ideas.length ? h('p', { class: 'hint', text: '“3×” = YouTube suggested it for 3 of the related searches TubeScout tried; “best #1” = its highest position there. A popularity hint, not search volume.' }) : null),
      h('div', { class: 'actions' },
        extLink('Research in TubeScout', L.dashboardUrl(server, { tab: 'keyword', q: d.keyword || page.query })),
        extLink('Open dashboard', L.dashboardUrl(server), 'btn ghost')),
      footer(res, 'YouTube autocomplete (no API quota)'));
  }

  function fillBar(pct) {
    const fill = h('div', { class: 'fill' });
    fill.style.width = `${pct}%`; // CSSOM, not a style attribute
    return fill;
  }

  function demandPath(q) {
    return L.apiPath('/api/demand', { q, hl: L.normalizeHl(document.documentElement.lang) });
  }

  // ---------- navigation (YouTube is a single-page app) ----------

  function onNavigate() {
    if (!chrome.runtime?.id) { teardown(); return; }
    if (location.href === state.href) { if (state.page.type) place(); return; }
    state.href = location.href;
    const page = L.parsePage(location.href);
    const key = L.pageKey(page);
    if (key === state.key) { place(); return; } // e.g. only &t= changed on the same video
    state.page = page;
    state.key = key;
    state.gen++;
    state.lastBody = null;
    state.loadedKey = '';
    state.keyword = '';
    state.demandConfirmed = false;
    if (!page.type) { host.remove(); return; }
    place();
    render();
  }

  function teardown() {
    clearInterval(timer);
    themeObserver?.disconnect();
    document.removeEventListener('yt-navigate-finish', onNavigate);
    window.removeEventListener('popstate', onNavigate);
    host.remove();
  }

  async function init() {
    syncTheme();
    themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
    try {
      const prefs = await send({ type: 'getPrefs' });
      state.collapsed = Boolean(prefs && prefs.collapsed);
    } catch { /* defaults */ }
    // 'yt-navigate-finish' is YouTube's own (undocumented) SPA event; the poll is the fallback.
    document.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);
    timer = setInterval(onNavigate, POLL_MS);
    onNavigate();
  }

  // ---------- styles (static; colors follow YouTube's light/dark theme) ----------

  function CSS() {
    return `
:host { all: initial; display: block; box-sizing: border-box; margin: 0 0 12px;
  --bg: #ffffff; --bg-2: #f2f2f2; --text: #0f0f0f; --muted: #606060; --border: #e5e5e5;
  --accent: #e5484d; --accent-ink: #fff; --good: #1f8a4c; --bad: #c4372f; --warn-bg: #fff4d6; --warn-ink: #6b4e00;
  --shadow: 0 4px 18px rgba(0,0,0,.12);
  font: 13px/1.45 Roboto, Arial, sans-serif; color: var(--text); }
:host([data-dark]) { --bg: #212121; --bg-2: #2f2f2f; --text: #f1f1f1; --muted: #aaaaaa; --border: #3f3f3f;
  --accent: #ff5c61; --good: #3ecf7a; --bad: #ff6b61; --warn-bg: #3a2f10; --warn-ink: #ffd98a; --shadow: 0 4px 18px rgba(0,0,0,.5); color-scheme: dark; }
:host([data-floating]) { position: fixed; top: 68px; right: 16px; z-index: 2019; margin: 0;
  width: min(360px, calc(100vw - 32px)); }
* { box-sizing: border-box; }
.panel { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
:host([data-floating]) .panel { box-shadow: var(--shadow); max-height: calc(100vh - 84px); display: flex; flex-direction: column; }
:host([data-floating]) .body { overflow-y: auto; overscroll-behavior: contain; }
.head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; cursor: pointer; user-select: none; border-bottom: 1px solid var(--border); }
.panel.collapsed .head { border-bottom: 0; }
.logo { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: var(--accent); color: var(--accent-ink); font-size: 10px; font-weight: 700; letter-spacing: .02em; }
.brand { font-weight: 700; font-size: 14px; }
.kind { color: var(--muted); font-size: 12px; }
.spacer { flex: 1; }
.icon-btn { all: unset; display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; color: var(--muted); }
.icon-btn:hover { background: var(--bg-2); color: var(--text); }
.icon-btn:focus-visible, .btn:focus-visible, .link:focus-visible, .input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ic { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.toggle .ic { transition: transform .15s; }
.panel.collapsed .toggle .ic { transform: rotate(-90deg); }
.body { padding: 10px 12px 12px; }
.title-line { font-weight: 600; font-size: 13px; margin: 0 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.kpi { background: var(--bg-2); border-radius: 8px; padding: 7px 9px; min-width: 0; }
.k-label { font-size: 11px; color: var(--muted); }
.k-value { font-size: 18px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.k-note { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pos { color: var(--good); } .neg { color: var(--bad); }
.muted { color: var(--muted); }
.hint { font-size: 11px; color: var(--muted); margin: 6px 0 0; }
p { margin: 6px 0; }
.sec { margin-top: 12px; }
.sec-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 6px; }
.checks, .outliers, .ideas { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.checks li { border-left: 3px solid var(--bad); padding: 2px 0 2px 8px; }
.c-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.c-label { font-weight: 600; }
.c-detail { font-size: 12px; color: var(--muted); }
.pill { font-size: 10px; border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; color: var(--muted); white-space: nowrap; }
.pill.rule { border-color: var(--accent); color: var(--accent); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.chip { background: var(--bg-2); border-radius: 999px; padding: 2px 8px; font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.more { color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; align-items: center; }
.btn { all: unset; display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 18px; background: var(--accent); color: var(--accent-ink); font-weight: 600; font-size: 12px; cursor: pointer; white-space: nowrap; }
.btn .ic { width: 13px; height: 13px; }
.btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); padding: 5px 11px; }
.btn.small { padding: 4px 10px; background: var(--bg-2); color: var(--text); }
.btn.done { background: var(--good); }
.btn[disabled] { opacity: .65; cursor: default; }
.btn:hover:not([disabled]) { filter: brightness(1.08); }
.link { color: var(--text); text-decoration: none; font-weight: 500; }
.link:hover { text-decoration: underline; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.o-meta, .i-meta { font-size: 11px; color: var(--muted); }
.score { font-weight: 700; }
.ideas li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.ideas .i-meta { margin-left: auto; }
.gauge { background: var(--bg-2); border-radius: 8px; padding: 8px 10px; }
.g-head { display: flex; justify-content: space-between; align-items: baseline; }
.g-value { font-size: 18px; font-weight: 700; }
.track { height: 6px; border-radius: 3px; background: var(--border); margin: 6px 0; overflow: hidden; }
.fill { height: 100%; background: var(--accent); }
.g-note { font-size: 12px; margin: 0; }
.kw-form { display: flex; gap: 6px; margin-top: 8px; }
.input { flex: 1; min-width: 0; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 18px; padding: 5px 10px; }
.banner { background: var(--warn-bg); color: var(--warn-ink); border-radius: 8px; padding: 6px 9px; font-size: 12px; margin-bottom: 8px; }
.error { border-left: 3px solid var(--bad); padding-left: 10px; }
.err-title { font-weight: 700; margin-bottom: 2px; }
.inline-err { color: var(--bad); font-size: 12px; margin-top: 4px; width: 100%; }
code, .cmd { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; background: var(--bg-2); border-radius: 4px; padding: 1px 4px; }
.cmd { display: block; padding: 6px 8px; margin: 6px 0; white-space: pre-wrap; }
.foot { margin-top: 10px; font-size: 11px; color: var(--muted); }
.foot-link { color: var(--muted); }
.foot-link .ic { width: 10px; height: 10px; vertical-align: -1px; margin-left: 2px; }
.loading { display: flex; align-items: center; gap: 8px; color: var(--muted); padding: 6px 0; }
.spin { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } .toggle .ic { transition: none; } }
.offscreen { position: fixed; left: -9999px; top: 0; }
`;
  }

  init();
})();
