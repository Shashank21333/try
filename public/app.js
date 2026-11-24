// TubeScout frontend: vanilla JS, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const TZ = new Date().getTimezoneOffset();
const TZ_NAME = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

// ---------- formatting helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const n = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : compact.format(x));
const pct = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const fx = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x.toFixed(d)}×`);
const num = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const ago = (days) => {
  if (days === null || days === undefined) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h ago`;
  if (days < 60) return `${Math.round(days)}d ago`;
  if (days < 730) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
};
const dur = (sec) => { const s = Math.round(sec); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
const ytVideo = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const ytChannel = (id) => `https://www.youtube.com/channel/${encodeURIComponent(id)}`;
const safeImg = (u) => (typeof u === 'string' && /^(https:|data:image\/svg\+xml)/.test(u) ? esc(u) : '');

const store = {
  get(k) { try { return localStorage.getItem(`tubescout:${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`tubescout:${k}`, v); } catch { /* ignore */ } },
};

// ---------- API ----------
async function api(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v !== undefined && v !== '') qs.set(k, v);
  }
  qs.set('tz', TZ);
  const res = await fetch(`/api/${path}?${qs}`);
  const body = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  if (body.meta) updateMeta(body.meta);
  return body;
}

function updateMeta(meta) {
  $('#demo-banner').hidden = meta.mode !== 'demo';
  $('#quota').textContent = meta.mode === 'live' ? `API quota used by this server since start: ~${meta.quotaUsedSinceStart} units.` : '';
}

// ---------- reusable UI pieces ----------
const loading = (msg) => `<div class="state"><div class="spinner"></div>${esc(msg)}</div>`;
const errorBox = (msg) => `<div class="error">${esc(msg)}</div>`;
const card = (title, desc, body, extra = '') => `<section class="card"><div class="card-head"><div><h2>${esc(title)}</h2>${desc ? `<p class="desc">${desc}</p>` : ''}</div>${extra}</div>${body}</section>`;
const kpi = (label, value, note = '') => `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;

function hbars(rows, { fmt = n, highlight } = {}) {
  const max = Math.max(...rows.map((r) => r.value || 0), 1e-9);
  return `<div class="bars">${rows.map((r, i) => `
    <div class="bar-row"><span class="name" title="${esc(r.label)}">${esc(r.label)}</span>
      <div class="bar-track"><div class="bar-fill ${highlight !== undefined && highlight !== i ? 'dim' : ''}" style="width:${((r.value || 0) / max) * 100}%"></div></div>
      <span class="val">${fmt(r.value)}</span></div>`).join('')}</div>`;
}

function columns(items, labelFn, { minCount = 1 } = {}) {
  const max = Math.max(...items.map((i) => (i.count >= minCount ? i.medianScore : 0)), 1e-9);
  const best = items.reduce((b, i, idx) => (i.count >= minCount && i.medianScore > (items[b]?.medianScore ?? -1) ? idx : b), -1);
  return `<div class="cols">${items.map((i, idx) => {
    const h = i.count >= minCount ? (i.medianScore / max) * 100 : 0;
    return `<div class="col" title="${esc(labelFn(i))}: ${i.count} uploads, median ${fx(i.medianScore, 2)} channel typical"><div class="fill ${idx === best ? '' : 'dim'}" style="height:${h}%"></div></div>`;
  }).join('')}</div><div class="cols-labels">${items.map((i) => `<span>${esc(labelFn(i))}</span>`).join('')}</div>`;
}

function videoGrid(videos, { scoreLabel = 'vs typical' } = {}) {
  if (!videos.length) return '<p class="muted">Not enough videos yet.</p>';
  return `<div class="videos">${videos.map((v) => `
    <a class="vid" href="${ytVideo(v.id)}" target="_blank" rel="noopener">
      ${safeImg(v.thumbnail) ? `<img loading="lazy" src="${safeImg(v.thumbnail)}" alt="">` : ''}
      <div class="body"><div class="t">${esc(v.title)}</div>
        <div class="m"><span>${esc(v.channelTitle)}</span><span>${ago(v.ageDays)}</span></div>
        <div class="m"><span>${n(v.views)} views${v.isShort ? ' · Short' : ''}</span><span class="score" title="${esc(scoreLabel)}">${fx(v.outlierScore)}</span></div>
      </div></a>`).join('')}</div>`;
}

function keywordTable(rows, { scoreHead = 'Median outlier', showChannels = true, colorize = true } = {}) {
  if (!rows.length) return '<p class="muted">Not enough repeated keywords in titles yet.</p>';
  return `<div class="table-wrap"><table><thead><tr><th class="l">Keyword</th><th>Videos</th>${showChannels ? '<th class="l">Used by</th>' : ''}<th>Median views</th><th>${esc(scoreHead)}</th></tr></thead><tbody>
    ${rows.map((k) => `<tr><td>${esc(k.term)}</td><td>${k.count}</td>${showChannels ? `<td class="l wrap muted">${esc(k.channels.slice(0, 4).join(', '))}${k.channels.length > 4 ? ` +${k.channels.length - 4}` : ''}</td>` : ''}<td>${n(k.medianViews)}</td><td class="${!colorize ? '' : k.medianScore >= 1.2 ? 'pos' : k.medianScore < 0.8 ? 'neg' : ''}">${fx(k.medianScore, 2)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

const tagCloud = (tags) => (tags.length ? tags.map((t) => `<span class="tag">${esc(t.tag)}<b>${t.count}</b></span>`).join('') : '<p class="muted">These videos have no public tags.</p>');

function titlePatternTable(tp) {
  return `<p class="desc">Median title length: <b>${num(tp.medianLength, 0)}</b> characters. "Lift" compares the median outlier score of titles with the pattern against those without it (needs at least 3 of each).</p>
  <div class="table-wrap"><table><thead><tr><th class="l">Pattern</th><th>Used in</th><th>With</th><th>Without</th><th>Lift</th></tr></thead><tbody>
  ${tp.features.map((f) => `<tr><td>${esc(f.label)}</td><td>${pct(f.share, 0)}</td><td>${fx(f.withScore, 2)}</td><td>${fx(f.withoutScore, 2)}</td>
    <td class="${f.lift === null ? 'muted' : f.lift >= 1.15 ? 'pos' : f.lift <= 0.87 ? 'neg' : ''}">${f.lift === null ? 'too few' : fx(f.lift, 2)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function scheduleCards(schedule) {
  const bestDay = [...schedule.days].filter((d) => d.count >= 2).sort((a, b) => b.medianScore - a.medianScore)[0];
  const hours = schedule.hours.map((h) => ({ ...h, label: String(h.hour) }));
  return `<div class="grid-2">
    ${card('Best upload day', `Median outlier score by weekday (${esc(TZ_NAME)}). Days with fewer than 2 uploads are left out.${bestDay ? ` Best: <b>${bestDay.day}</b>.` : ''}`,
      columns(schedule.days, (d) => d.day, { minCount: 2 }))}
    ${card('Upload hour', `Median outlier score by hour of day (${esc(TZ_NAME)}). Hover a bar for counts.`,
      columns(hours, (h) => (h.hour % 3 === 0 ? h.label : ''), { minCount: 2 }))}
  </div>`;
}

function makeSortable(table, rows, renderRow) {
  let key = null, dir = -1;
  table.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    dir = key === k ? -dir : -1; key = k;
    const sorted = [...rows].sort((a, b) => {
      const x = a[k], y = b[k];
      if (typeof x === 'string') return dir * x.localeCompare(y);
      return dir * ((x ?? -Infinity) - (y ?? -Infinity));
    });
    table.tBodies[0].innerHTML = sorted.map(renderRow).join('');
  }));
}

function toCsv(rows, cols) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map((c) => c.head).join(','), ...rows.map((r) => cols.map((c) => cell(c.get(r))).join(','))].join('\n');
}
function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const VIDEO_CSV = [
  { head: 'title', get: (v) => v.title }, { head: 'channel', get: (v) => v.channelTitle }, { head: 'url', get: (v) => ytVideo(v.id) },
  { head: 'published', get: (v) => v.publishedAt }, { head: 'views', get: (v) => v.views }, { head: 'likes', get: (v) => v.likes },
  { head: 'comments', get: (v) => v.comments }, { head: 'duration_sec', get: (v) => v.durationSec }, { head: 'short', get: (v) => v.isShort },
  { head: 'views_per_day', get: (v) => v.viewsPerDay?.toFixed(1) }, { head: 'engagement_rate', get: (v) => v.engagementRate?.toFixed(4) },
  { head: 'outlier_score', get: (v) => v.outlierScore?.toFixed(3) }, { head: 'tags', get: (v) => v.tags.join('|') },
];

// ---------- Competitors tab ----------
function renderCompare(data) {
  const ch = data.channels;
  if (!ch.length) return data.errors.map((e) => errorBox(`${e.input}: ${e.message}`)).join('');
  const bestOf = (key, lowIsBest = false) => {
    const vals = ch.map((c) => c[key]).filter(Number.isFinite);
    return vals.length ? (lowIsBest ? Math.min(...vals) : Math.max(...vals)) : null;
  };
  const cell = (c, key, fmt, lowIsBest) => `<td class="${ch.length > 1 && c[key] === bestOf(key, lowIsBest) ? 'best' : ''}">${fmt(c[key])}</td>`;
  const table = `<div class="table-wrap"><table><thead><tr>
      <th class="l">Channel</th><th>Subscribers</th><th>Videos</th><th>Median views</th><th>Long-form median</th><th>Shorts median</th>
      <th>Uploads / week</th><th>Engagement</th><th>Shorts share</th><th>Views / sub</th><th>Last upload</th></tr></thead><tbody>
    ${ch.map((c, i) => `<tr class="${i === 0 ? 'me' : ''}">
      <td><a class="chip" href="${ytChannel(c.id)}" target="_blank" rel="noopener">${safeImg(c.thumbnail) ? `<img src="${safeImg(c.thumbnail)}" alt="">` : ''}${esc(c.title)}</a>${i === 0 ? ' <span class="muted">(you)</span>' : ''}</td>
      ${cell(c, 'subscribers', n)}${cell(c, 'totalVideos', n)}${cell(c, 'medianViews', n)}${cell(c, 'medianViewsLong', n)}${cell(c, 'medianViewsShorts', n)}
      ${cell(c, 'uploadsPerWeek', (x) => num(x))}${cell(c, 'avgEngagement', (x) => pct(x, 2))}<td>${pct(c.shortsShare, 0)}</td>
      ${cell(c, 'viewsPerSubscriber', (x) => pct(x, 1))}${cell(c, 'daysSinceLastUpload', ago, true)}</tr>`).join('')}
    </tbody></table></div>
    <p class="hint">Medians use each channel's most recent ${ch[0].sampleSize} uploads. Shorts = videos of 3 minutes or less (the API has no Shorts flag). Subscriber counts are rounded by YouTube. Green = best in group.</p>`;

  const bar = (key, fmt) => hbars(ch.map((c) => ({ label: c.title, value: c[key] })), { fmt, highlight: 0 });
  return `
    ${data.errors.map((e) => errorBox(`Couldn't load "${e.input}": ${e.message}`)).join('')}
    ${card('Head-to-head', 'Your channel is highlighted. All stats are calculated from recent uploads, not lifetime totals, except subscribers and video count.', table,
      `<button class="ghost" id="dl-compare">Export videos CSV</button>`)}
    <div class="grid-2">
      ${card('Median views per video', '', bar('medianViews', n))}
      ${card('Uploads per week (last 90 days)', '', bar('uploadsPerWeek', (x) => num(x)))}
      ${card('Engagement rate', '(likes + comments) ÷ views, averaged per video', bar('avgEngagement', (x) => pct(x, 2)))}
      ${card('Views per subscriber', 'Median views ÷ subscribers. Higher = the audience actually watches new uploads.', bar('viewsPerSubscriber', (x) => pct(x, 1)))}
    </div>
    <div class="stack" style="margin-top:18px">
    ${card('Outlier videos across competitors', 'Videos that beat their own channel\'s typical views (same format) by the most. These topics and packages are proven with this audience: study the title, thumbnail and hook. Videos under 2 days old are left out.', videoGrid(data.outliers))}
    ${card('Keywords competitors use in titles', 'Words and two-word phrases used in 3+ titles. A high median outlier score means videos with this keyword usually beat their channel\'s typical views.', keywordTable(data.keywords))}
    ${scheduleCards(data.schedule)}
    ${card('What title styles work in this niche', '', titlePatternTable(data.titlePatterns))}
    ${card('Most-used tags', 'Tags are mostly a minor ranking signal, but they reveal which topics competitors target.', tagCloud(data.tags))}
    </div>`;
}

// ---------- Channel tab ----------
function renderChannel(d) {
  const c = d.channel;
  const f = d.formats;
  const head = `<div class="ch-head">${safeImg(c.thumbnail) ? `<img src="${safeImg(c.thumbnail)}" alt="">` : ''}<div>
      <h2><a href="${ytChannel(c.id)}" target="_blank" rel="noopener">${esc(c.title)}</a></h2>
      <div class="meta">${esc(c.handle || '')}${c.country ? ` · ${esc(c.country)}` : ''}${c.createdAt ? ` · since ${new Date(c.createdAt).getFullYear()}` : ''} · analyzed ${c.sampleSize} recent uploads</div></div></div>`;
  const kpis = `<div class="kpis">
    ${kpi('Subscribers', n(c.subscribers), c.subscribers === null ? 'hidden by channel' : 'rounded by YouTube')}
    ${kpi('Lifetime views', n(c.totalViews))}
    ${kpi('Videos', n(c.totalVideos))}
    ${kpi('Median views', n(c.medianViews), 'recent uploads')}
    ${kpi('Uploads / week', num(c.uploadsPerWeek), `last ${c.uploadsWindowDays} days`)}
    ${kpi('Engagement', pct(c.avgEngagement, 2), '(likes+comments)/views')}
    ${kpi('Views / subscriber', pct(c.viewsPerSubscriber), 'median views ÷ subs')}
    ${kpi('Last upload', ago(c.daysSinceLastUpload))}
  </div>`;
  const formats = `<div class="table-wrap"><table><thead><tr><th class="l">Format</th><th>Videos</th><th>Median views</th><th>Engagement</th><th>Median length</th></tr></thead><tbody>
    <tr><td>Long-form (&gt; 3 min)</td><td>${f.long.count}</td><td>${n(f.long.medianViews)}</td><td>${pct(f.long.avgEngagement, 2)}</td><td>${f.long.count ? dur(f.long.medianDurationSec) : '—'}</td></tr>
    <tr><td>Shorts (≤ 3 min)</td><td>${f.shorts.count}</td><td>${n(f.shorts.medianViews)}</td><td>${pct(f.shorts.avgEngagement, 2)}</td><td>${f.shorts.count ? dur(f.shorts.medianDurationSec) : '—'}</td></tr>
  </tbody></table></div>`;

  const row = (v) => `<tr><td class="l wrap"><a href="${ytVideo(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></td><td>${ago(v.ageDays)}</td><td>${v.isShort ? 'Short' : dur(v.durationSec)}</td>
    <td>${n(v.views)}</td><td>${n(v.viewsPerDay)}</td><td>${pct(v.engagementRate, 2)}</td><td class="${v.outlierScore >= 2 ? 'pos' : v.outlierScore < 0.5 ? 'neg' : ''}">${fx(v.outlierScore)}</td></tr>`;
  const videos = `<div class="table-wrap"><table id="vid-table"><thead><tr><th class="l" data-sort="title">Title</th><th data-sort="ageDays">Published</th><th data-sort="durationSec">Length</th>
    <th data-sort="views">Views</th><th data-sort="viewsPerDay">Views/day</th><th data-sort="engagementRate">Engagement</th><th data-sort="outlierScore">Outlier</th></tr></thead>
    <tbody>${d.videos.map(row).join('')}</tbody></table></div>`;

  return `
    ${card(c.title, '', head + kpis)}
    <div class="stack">
    ${card('Breakout videos', 'This channel\'s uploads that most beat its own typical views (Shorts and long-form are scored separately).', videoGrid(d.outliers))}
    ${card('Shorts vs long-form', '', formats)}
    ${scheduleCards(d.schedule)}
    <div class="grid-2">
      ${card('Title keywords', 'Words/phrases used in 2+ titles and how those videos performed.', keywordTable(d.keywords, { showChannels: false }))}
      ${card('Title patterns', '', titlePatternTable(d.titlePatterns))}
    </div>
    ${card('Channel keywords', 'Keywords the creator set in YouTube Studio (channel settings).', c.keywords.length ? c.keywords.map((k) => `<span class="tag">${esc(k)}</span>`).join('') : '<p class="muted">None set.</p>')}
    ${card('Video tags', 'Tags used across recent uploads, with how many videos use each.', tagCloud(d.tags))}
    ${card('All analyzed videos', 'Click a column to sort.', videos, '<button class="ghost" id="dl-channel">Export CSV</button>')}
    </div>`;
}

// ---------- Keyword tab ----------
function renderKeyword(d) {
  const s = d.summary;
  const gauge = (label, value, note) => `<div class="gauge"><div class="label">${esc(label)}</div><div class="value">${value}<span class="muted" style="font-size:14px">/100</span></div><div class="track"><div style="width:${value}%"></div></div><div class="kpi note" style="padding:0;background:none">${note}</div></div>`;
  const gauges = `<div class="gauges">
      ${gauge('Opportunity', s.opportunity, 'High demand + beatable competition')}
      ${gauge('Demand', s.demand, `Top results earn a median of ${n(s.medianViewsPerDay)} views/day`)}
      ${gauge('Competition', s.competition, `Median ranking channel has ${n(s.medianChannelSubscribers)} subs`)}
    </div>
    <div class="kpis" style="margin-top:12px">
      ${kpi('Median views', n(s.medianViews), `top ${s.resultCount} results`)}
      ${kpi('Small channels ranking', pct(s.smallChannelShare, 0), 'under 100K subscribers')}
      ${kpi('Fresh results', pct(s.recentShare, 0), 'published in last 6 months')}
      ${kpi('Overperformers', String(s.overperformers), 'videos with more views than their channel has subs')}
    </div>
    <p class="hint">Scores are heuristics from the top YouTube search results for this query, not YouTube's own search volume. Demand: log scale where 100K views/day = 100. Competition: log scale where 10M subscribers = 100.</p>`;

  const row = (v) => `<tr><td>${v.rank}</td><td class="l wrap"><a href="${ytVideo(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></td><td class="l">${esc(v.channelTitle)}</td>
    <td>${n(v.channelSubscribers)}</td><td>${n(v.views)}</td><td>${n(v.viewsPerDay)}</td><td>${ago(v.ageDays)}</td><td class="${v.viewsToSubs >= 1 ? 'pos' : ''}">${fx(v.viewsToSubs, 2)}</td></tr>`;
  const results = `<div class="table-wrap"><table id="kw-table"><thead><tr><th data-sort="rank">#</th><th class="l" data-sort="title">Video</th><th class="l" data-sort="channelTitle">Channel</th>
      <th data-sort="channelSubscribers">Subs</th><th data-sort="views">Views</th><th data-sort="viewsPerDay">Views/day</th><th data-sort="ageDays">Age</th><th data-sort="viewsToSubs">Views ÷ subs</th></tr></thead>
      <tbody>${d.videos.map(row).join('')}</tbody></table></div>`;

  const chans = `<div class="table-wrap"><table><thead><tr><th class="l">Channel</th><th>Subs</th><th>Results</th><th>Best rank</th><th>Median views</th><th></th></tr></thead><tbody>
    ${d.channels.map((c) => `<tr><td><a class="chip" href="${ytChannel(c.id)}" target="_blank" rel="noopener">${safeImg(c.thumbnail) ? `<img src="${safeImg(c.thumbnail)}" alt="">` : ''}${esc(c.title)}</a></td>
      <td>${n(c.subscribers)}</td><td>${c.appearances}</td><td>${c.bestRank}</td><td>${n(c.medianViews)}</td>
      <td><button class="ghost add-comp" data-id="${esc(c.id)}">+ Compare</button></td></tr>`).join('')}
  </tbody></table></div>`;

  return `${card(`"${d.query}"`, '', gauges)}
    <div class="stack">
    ${card('Top ranking videos', 'Click a column to sort. "Views ÷ subs" above 1× means the video outgrew its channel: a strong sign the topic itself pulls viewers.', results, '<button class="ghost" id="dl-keyword">Export CSV</button>')}
    <div class="grid-2">
      ${card('Competitors for this keyword', 'Channels that rank for this query. Add them to the Competitors tab to track them.', chans)}
      ${card('Related keywords', 'Words and phrases that appear in 2+ of the ranking titles. "Median views ÷ subs" shows how well those videos did relative to their channel size.', keywordTable(d.relatedKeywords, { scoreHead: 'Median views ÷ subs', showChannels: false, colorize: false }))}
    </div>
    ${card('Tags used by ranking videos', '', tagCloud(d.tags))}
    </div>`;
}

// ---------- wiring ----------
function setTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  store.set('tab', name);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

async function run(form, out, msg, fn) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  out.innerHTML = loading(msg);
  try { await fn(); } catch (e) { out.innerHTML = errorBox(e.message); } finally { btn.disabled = false; }
}

$('#form-compare').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('#compare-input').value;
  const list = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const out = $('#out-compare');
  if (!list.length) { out.innerHTML = errorBox('Add at least one channel.'); return; }
  store.set('compare', raw);
  run(e.target, out, `Analyzing ${list.length} channel${list.length > 1 ? 's' : ''}…`, async () => {
    const data = await api('compare', { q: list, max: $('#compare-max').value });
    out.innerHTML = renderCompare(data);
    $('#dl-compare')?.addEventListener('click', () => download('competitor-outliers.csv', toCsv(data.outliers, VIDEO_CSV)));
  });
});

$('#form-channel').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#channel-input').value.trim();
  const out = $('#out-channel');
  if (!q) { out.innerHTML = errorBox('Enter a channel.'); return; }
  store.set('channel', q);
  run(e.target, out, 'Fetching uploads…', async () => {
    const data = await api('channel', { q, max: $('#channel-max').value });
    out.innerHTML = renderChannel(data);
    const rowFn = (v) => `<tr><td class="l wrap"><a href="${ytVideo(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></td><td>${ago(v.ageDays)}</td><td>${v.isShort ? 'Short' : dur(v.durationSec)}</td><td>${n(v.views)}</td><td>${n(v.viewsPerDay)}</td><td>${pct(v.engagementRate, 2)}</td><td class="${v.outlierScore >= 2 ? 'pos' : v.outlierScore < 0.5 ? 'neg' : ''}">${fx(v.outlierScore)}</td></tr>`;
    makeSortable($('#vid-table'), data.videos, rowFn);
    $('#dl-channel').addEventListener('click', () => download(`${data.channel.title.replace(/[^\w-]+/g, '_')}-videos.csv`, toCsv(data.videos, VIDEO_CSV)));
  });
});

$('#form-keyword').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#keyword-input').value.trim();
  const out = $('#out-keyword');
  if (!q) { out.innerHTML = errorBox('Enter a keyword.'); return; }
  store.set('keyword', q);
  run(e.target, out, 'Searching YouTube…', async () => {
    const data = await api('keyword', { q, region: $('#keyword-region').value.trim().toUpperCase() });
    out.innerHTML = renderKeyword(data);
    const rowFn = (v) => `<tr><td>${v.rank}</td><td class="l wrap"><a href="${ytVideo(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></td><td class="l">${esc(v.channelTitle)}</td><td>${n(v.channelSubscribers)}</td><td>${n(v.views)}</td><td>${n(v.viewsPerDay)}</td><td>${ago(v.ageDays)}</td><td class="${v.viewsToSubs >= 1 ? 'pos' : ''}">${fx(v.viewsToSubs, 2)}</td></tr>`;
    makeSortable($('#kw-table'), data.videos, rowFn);
    $('#dl-keyword').addEventListener('click', () => download(`keyword-${q.replace(/[^\w-]+/g, '_')}.csv`,
      toCsv(data.videos, [...VIDEO_CSV.filter((c) => c.head !== 'outlier_score'), { head: 'channel_subscribers', get: (v) => v.channelSubscribers }, { head: 'rank', get: (v) => v.rank }])));
    out.querySelectorAll('.add-comp').forEach((b) => b.addEventListener('click', () => {
      const ta = $('#compare-input');
      const lines = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.includes(b.dataset.id)) lines.push(b.dataset.id);
      ta.value = lines.join('\n');
      b.textContent = 'Added ✓';
      b.disabled = true;
    }));
  });
});

// restore last inputs
$('#compare-input').value = store.get('compare') || '';
$('#channel-input').value = store.get('channel') || '';
$('#keyword-input').value = store.get('keyword') || '';
setTab(store.get('tab') || 'compare');
api('status', {}).then(updateMeta).catch(() => {});
