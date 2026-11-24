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

const state = { meta: null };

async function apiPost(path, body) {
  const res = await fetch(path.startsWith('/') ? path : `/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const signed = (x, f = n) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${f(Math.abs(x))}`);

/** Minimal responsive SVG line chart. points: [{t, v}] */
function lineChart(points, { fmtY = n, fmtX = shortDate, label = 'chart', height = 140, minZero = false } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t));
  if (pts.length < 2) return '<p class="muted">Not enough data points yet. Check back after the next snapshot.</p>';
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = minZero ? Math.min(0, ...ys) : Math.min(...ys), y1 = Math.max(...ys);
  const W = 600, H = height, pad = 6;
  const sx = (t) => (x1 === x0 ? W / 2 : ((t - x0) / (x1 - x0)) * W);
  const sy = (v) => (y1 === y0 ? H / 2 : H - pad - ((v - y0) / (y1 - y0)) * (H - 2 * pad));
  const d = pts.map((p) => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
  const area = `0,${H} ${d} ${W},${H}`;
  return `<div class="line"><div class="line-y"><span>${fmtY(y1)}</span><span>${fmtY(y0)}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      <polygon points="${area}" fill="var(--bar)" opacity=".08"/>
      <polyline points="${d}" fill="none" stroke="var(--bar)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg><div class="line-x"><span>${fmtX(x0)}</span><span>${fmtX(x1)}</span></div></div>`;
}

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
  state.meta = meta;
  $('#quota').textContent = meta.mode === 'live'
    ? `YouTube API used by this server since start: ~${meta.quotaUsedSinceStart} of 10,000 daily units, ${meta.searchCallsSinceStart ?? 0} of ~100 daily search calls.`
    : '';
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
  const cell = (v) => {
    let s = String(v ?? '');
    // Third-party titles could start with =, +, - or @ and run as spreadsheet formulas: prefix them with '.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
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
      `<div class="row" style="margin:0"><button class="ghost" id="track-all" data-ids="${esc(JSON.stringify(ch.map((c) => c.id)))}">Track these channels daily</button><button class="ghost" id="dl-compare">Export videos CSV</button></div>`)}
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
  revealActiveTab();
}

// On narrow screens the tab bar scrolls sideways: keep the active tab in view (after a reload, a deep link
// to a tab near the end, or a tab label growing, e.g. "Alerts (4)"). Only the bar scrolls, never the page.
function revealActiveTab() {
  const nav = document.querySelector('.tabs');
  const btn = nav?.querySelector('[aria-selected="true"]');
  if (!btn || nav.scrollWidth <= nav.clientWidth) return;
  const nr = nav.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  if (br.left < nr.left) nav.scrollLeft -= nr.left - br.left + 16;
  else if (br.right > nr.right) nav.scrollLeft += br.right - nr.right + 16;
}
new MutationObserver(revealActiveTab).observe(document.querySelector('.tabs'), { childList: true, subtree: true, characterData: true });
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

// ---------- Search demand (Keyword tab) ----------
function renderDemand(d) {
  const ac = d.autocomplete || {};
  const acCard = ac.error ? errorBox(`YouTube autocomplete: ${ac.error}`) : `
    <div class="gauge"><div class="label">Autocomplete strength (YouTube)</div>
      <div class="value">${ac.strength ?? 0}<span class="muted" style="font-size:14px">/100</span></div>
      <div class="track"><div style="width:${ac.strength ?? 0}%"></div></div>
      <div class="note">${ac.found
        ? `YouTube suggests it after typing <b>“${esc(ac.prefix)}”</b> (${ac.prefixLength} of ${ac.keywordLength} characters), at position #${ac.position}. The earlier it appears, the more people search it.`
        : 'Not suggested by YouTube even when typed in full: very few people search this exact phrase.'}</div></div>`;

  const vol = d.volume || {};
  const volById = new Map((vol.items || []).map((i) => [i.keyword, i]));
  const main = volById.get(d.keyword);
  const volCard = !vol.enabled
    ? `<div class="gauge"><div class="label">Monthly searches (Google)</div><div class="value muted">—</div><div class="note">Add <code>KE_API_KEY</code> (Keywords Everywhere) to show Google Keyword Planner volume, CPC and competition.</div></div>`
    : vol.error ? errorBox(vol.error)
      : `<div class="gauge"><div class="label">Monthly searches (Google, ${esc((vol.country || '').toUpperCase())})</div>
          <div class="value">${main ? n(main.volume) : '—'}</div>
          <div class="note">${main ? `CPC ${main.cpcCurrency || ''}${num(main.cpc, 2)} · competition ${num(main.competition, 2)}` : 'No data for this phrase'}${vol.creditsLeft !== null ? ` · ${n(vol.creditsLeft)} credits left` : ''}</div></div>`;

  const tr = d.trends || {};
  const trendLink = `<a href="${esc(tr.url)}" target="_blank" rel="noopener">Open in Google Trends (YouTube Search)</a>`;
  let trendBody;
  if (!tr.enabled) trendBody = `<p class="desc">Add <code>SERPAPI_KEY</code> to chart 12 months of YouTube-search interest here. Meanwhile: ${trendLink}.</p>`;
  else if (tr.error) trendBody = errorBox(tr.error) + `<p class="desc">${trendLink}</p>`;
  else if (tr.noData) trendBody = `<p class="desc">Google Trends has too little YouTube search data for this phrase. That usually means low search interest. ${trendLink}</p>`;
  else {
    const chg = tr.change;
    trendBody = `<p class="desc">Relative interest in YouTube Search, 0–100 (100 = peak in the period). Last 3 months vs the 3 before:
      <b class="${chg > 0.05 ? 'pos' : chg < -0.05 ? 'neg' : ''}">${chg === null ? '—' : signed(chg * 100, (x) => `${x.toFixed(0)}%`)}</b>. ${trendLink}</p>
      ${lineChart(tr.timeline.map((p) => ({ t: p.timestamp, v: p.value })), { fmtY: (x) => x.toFixed(0), label: 'YouTube search interest', minZero: true })}
      ${tr.rising?.length ? `<p class="desc" style="margin-top:12px"><b>Rising related searches</b></p>${tr.rising.map((r) => `<span class="tag idea" data-kw="${esc(r.query)}">${esc(r.query)}<b>${esc(r.label)}</b></span>`).join('')}` : ''}
      ${tr.top?.length ? `<p class="desc" style="margin-top:8px"><b>Top related searches</b></p>${tr.top.map((r) => `<span class="tag idea" data-kw="${esc(r.query)}">${esc(r.query)}<b>${r.value}</b></span>`).join('')}` : ''}`;
  }

  const ideas = Array.isArray(d.ideas) ? d.ideas : [];
  const ideaRows = (list) => list.map((i) => {
    const v = volById.get(i.keyword);
    return `<tr><td class="l wrap"><button class="linkish idea" data-kw="${esc(i.keyword)}">${esc(i.keyword)}</button></td><td>${i.appearances}</td><td>#${i.bestPosition}</td>${vol.enabled ? `<td>${v ? n(v.volume) : '—'}</td><td>${v && v.cpc !== null ? num(v.cpc, 2) : '—'}</td>` : ''}</tr>`;
  }).join('');
  const ideaTable = (list) => (list.length ? `<div class="table-wrap"><table><thead><tr><th class="l">Keyword</th><th title="How many autocomplete lookups surfaced it">Seen in</th><th>Best position</th>${vol.enabled ? '<th>Google searches/mo</th><th>CPC</th>' : ''}</tr></thead><tbody>${ideaRows(list)}</tbody></table></div>` : '<p class="muted">None found.</p>');
  const ideasBody = d.ideas?.error ? errorBox(d.ideas.error) : `<div class="grid-2">
      <div><h3 class="sub-h">Questions people ask</h3>${ideaTable(ideas.filter((i) => i.type === 'question').slice(0, 25))}</div>
      <div><h3 class="sub-h">Long-tail phrases</h3>${ideaTable(ideas.filter((i) => i.type !== 'question').slice(0, 40))}</div></div>`;

  return `${card(`Search demand: “${d.keyword}”`, 'YouTube does not publish search volume, so no tool has exact YouTube numbers. These are real signals, each labelled with its source.',
      `<div class="gauges">${acCard}${volCard}</div>`, '<button class="ghost" id="dl-ideas">Export ideas CSV</button>')}
    ${card('YouTube search interest over time', 'Source: Google Trends, “YouTube Search” property.', trendBody)}
    ${card('Keyword ideas from YouTube autocomplete', 'Real searches people type into YouTube, found by expanding your keyword with a–z, question words and modifiers. Click one to research it.', ideasBody)}`;
}

function wireIdeas(root, data) {
  root.querySelectorAll('.idea').forEach((el) => el.addEventListener('click', () => {
    $('#keyword-input').value = el.dataset.kw;
    $('#form-keyword').requestSubmit();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  $('#dl-ideas')?.addEventListener('click', () => {
    const vol = new Map((data.volume?.items || []).map((i) => [i.keyword, i]));
    const rows = Array.isArray(data.ideas) ? data.ideas : [];
    download(`ideas-${data.keyword.replace(/[^\w-]+/g, '_')}.csv`, toCsv(rows, [
      { head: 'keyword', get: (i) => i.keyword }, { head: 'type', get: (i) => i.type }, { head: 'seen_in', get: (i) => i.appearances },
      { head: 'best_position', get: (i) => i.bestPosition }, { head: 'google_monthly_searches', get: (i) => vol.get(i.keyword)?.volume ?? '' },
      { head: 'cpc', get: (i) => vol.get(i.keyword)?.cpc ?? '' },
    ]));
  });
}

$('#form-keyword').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#keyword-input').value.trim();
  const out = $('#out-keyword');
  const outD = $('#out-demand');
  if (!q) { out.innerHTML = errorBox('Enter a keyword.'); return; }
  store.set('keyword', q);
  const region = $('#keyword-region').value.trim().toUpperCase();
  outD.innerHTML = loading('Checking YouTube autocomplete and search demand…');
  api('demand', { q, region, hl: $('#keyword-hl').value })
    .then((d) => { outD.innerHTML = renderDemand(d); wireIdeas(outD, d); })
    .catch((err) => { outD.innerHTML = errorBox(`Search demand: ${err.message}`); });
  run(e.target, out, 'Searching YouTube…', async () => {
    const data = await api('keyword', { q, region });
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

// ---------- Tracking tab ----------
function deltaCell(dl, key, f = n) {
  if (!dl || dl[key] === null || dl[key] === undefined) return '<td class="muted">—</td>';
  const v = dl[key];
  const note = dl.partial ? ` title="Only ${Math.max(1, Math.round((Date.now() - dl.sinceT) / 86400000))} day(s) of history so far (since ${shortDate(dl.sinceT)})"` : '';
  return `<td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}"${note}>${signed(v, f)}${dl.partial ? '*' : ''}</td>`;
}

function renderTracking(d) {
  if (!d.channels.length) return `<div class="state">You're not tracking any channels yet. Add your channel and your competitors above, or use “Track these channels” on the Competitors tab.</div>`;
  const rows = d.channels.map((c) => `<tr>
      <td><a class="chip" href="${ytChannel(c.id)}" target="_blank" rel="noopener">${safeImg(c.thumbnail) ? `<img src="${safeImg(c.thumbnail)}" alt="">` : ''}${esc(c.title)}</a></td>
      <td>${n(c.subscribers)}</td>${deltaCell(c.d1, 'subs')}${deltaCell(c.d7, 'subs')}${deltaCell(c.d30, 'subs')}
      <td>${c.d7?.viewsPerDay != null ? n(c.d7.viewsPerDay) : '—'}</td>${deltaCell(c.d30, 'views')}${deltaCell(c.d30, 'videos', (x) => String(x))}
      <td>${c.snapshots || 0}</td><td>${c.lastT ? ago((Date.now() - c.lastT) / 86400000) : '—'}</td>
      <td><button class="ghost untrack" data-id="${esc(c.id)}" aria-label="Stop tracking ${esc(c.title)}">Remove</button></td></tr>`).join('');
  const table = `<div class="table-wrap"><table><thead><tr><th class="l">Channel</th><th>Subscribers</th><th>Subs 24h</th><th>Subs 7d</th><th>Subs 30d</th>
      <th>Views/day (7d)</th><th>Views 30d</th><th>Uploads 30d</th><th>Snapshots</th><th>Last snapshot</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">* = less history than the period so far. Subscriber counts are rounded by YouTube (3 significant figures), so small daily changes can show as 0.</p>`;

  const trending = d.trending.length ? `<div class="table-wrap"><table><thead><tr><th class="l">Video</th><th class="l">Channel</th><th>Views/day now</th><th>Channel typical</th><th>Ratio</th></tr></thead><tbody>
      ${d.trending.map((v) => `<tr><td class="l wrap"><a href="${ytVideo(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a>${v.isNew ? ' <span class="badge">new</span>' : ''}</td><td class="l">${esc(v.channelTitle)}</td>
        <td>${n(v.gainPerDay)}</td><td>${n(v.typicalGainPerDay)}</td><td class="pos">${fx(v.ratio)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nothing is spiking right now. This needs at least two snapshots 12+ hours apart.</p>';

  const uploads = d.newUploads.length ? `<div class="videos">${d.newUploads.map((v) => `
      <a class="vid" href="${ytVideo(v.id)}" target="_blank" rel="noopener">${safeImg(v.thumbnail) ? `<img loading="lazy" src="${safeImg(v.thumbnail)}" alt="">` : ''}
        <div class="body"><div class="t">${esc(v.title)}</div><div class="m"><span>${esc(v.channelTitle)}</span><span>${ago((Date.now() - Date.parse(v.publishedAt)) / 86400000)}</span></div>
        <div class="m"><span>${n(v.views)} views${v.isShort ? ' · Short' : ''}</span><span>${n(v.viewsPerDay)}/day</span></div></div></a>`).join('')}</div>`
    : '<p class="muted">No uploads in the last 7 days.</p>';

  const charts = d.channels.filter((c) => c.series?.length).map((c) => card(c.title, `Tracked since ${shortDate(c.firstT)}`, `<div class="grid-2">
      <div><h3 class="sub-h">Subscribers</h3>${lineChart(c.series.map((p) => ({ t: p.t, v: p.subs })), { label: `${c.title} subscribers` })}</div>
      <div><h3 class="sub-h">Total views</h3>${lineChart(c.series.map((p) => ({ t: p.t, v: p.views })), { label: `${c.title} views` })}</div></div>`)).join('');

  return `${card('Tracked channels', '', table, '<button class="ghost" id="snap-now">Snapshot now</button>')}
    <div class="stack">
    ${card('Trending now', 'Videos gaining views much faster than their channel’s other recent videos since the previous snapshot. Spot breakouts while they are happening.', trending)}
    ${card('New uploads (last 7 days)', '', uploads)}
    ${charts}</div>`;
}

async function loadTracking() {
  const out = $('#out-tracking');
  out.innerHTML = loading('Loading tracked channels…');
  try {
    const d = await api('tracked', {});
    out.innerHTML = renderTracking(d);
    out.querySelectorAll('.untrack').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await apiPost('tracked/remove', { id: b.dataset.id }); loadTracking(); } catch (err) { b.disabled = false; alert(err.message); }
    }));
    $('#snap-now')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true; ev.target.textContent = 'Saving snapshots…';
      try { await apiPost('tracked/refresh', {}); } catch (err) { alert(err.message); }
      loadTracking();
    });
  } catch (err) { out.innerHTML = errorBox(err.message); }
}

$('#form-track').addEventListener('submit', (e) => {
  e.preventDefault();
  const channel = $('#track-input').value.trim();
  if (!channel) return;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  apiPost('tracked', { channel })
    .then(() => { $('#track-input').value = ''; return loadTracking(); })
    .catch((err) => { $('#out-tracking').insertAdjacentHTML('afterbegin', errorBox(err.message)); })
    .finally(() => { btn.disabled = false; });
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('#track-all');
  if (!b) return;
  const ids = JSON.parse(b.dataset.ids || '[]');
  b.disabled = true;
  let done = 0;
  for (const id of ids) {
    b.textContent = `Tracking ${++done}/${ids.length}…`;
    try { await apiPost('tracked', { channel: id }); } catch (err) { alert(err.message); break; }
  }
  b.textContent = 'Tracking ✓';
});

// ---------- My channel tab ----------
const pctChange = (cur, prev) => (Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0 ? (cur - prev) / Math.abs(prev) : null);
const changeNote = (cur, prev) => {
  const c = pctChange(cur, prev);
  return c === null ? 'vs previous period: —' : `<span class="${c > 0 ? 'pos' : c < 0 ? 'neg' : ''}">${signed(c * 100, (x) => `${x.toFixed(1)}%`)}</span> vs previous period`;
};

function renderMeSetup(d) {
  if (!d.configured) {
    return card('Connect your own channel', 'See your private YouTube Analytics (watch time, retention, traffic sources, search terms, audience) next to your competitor research.', `
      <ol class="steps">
        <li>In <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">Google Cloud Console</a>, enable <b>YouTube Data API v3</b> and <b>YouTube Analytics API</b>.</li>
        <li>Go to <b>APIs &amp; Services → OAuth consent screen</b>, choose <b>External</b>, and add your Google account as a test user.</li>
        <li>Go to <b>Credentials → Create credentials → OAuth client ID → Web application</b>. Add this authorized redirect URI:<br><code>${esc(location.origin)}/auth/google/callback</code></li>
        <li>Put <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code> and restart TubeScout.</li>
      </ol>`);
  }
  return card('Connect your own channel', 'Sign in with the Google account that owns your channel. TubeScout only asks for read-only access, and your sign-in is stored only on this computer.',
    `${d.error ? errorBox(d.error) : ''}<a class="primary btn-link" href="/auth/google">Connect with Google</a>`);
}

function renderMe(d) {
  const t = d.totals || {}, p = d.previous || {};
  const ch = d.channel || {};
  const netSubs = (o) => (Number.isFinite(o.subscribersGained) ? o.subscribersGained - (o.subscribersLost || 0) : null);
  const head = `<div class="ch-head">${safeImg(ch.thumbnail) ? `<img src="${safeImg(ch.thumbnail)}" alt="">` : ''}<div>
      <h2>${esc(ch.title || 'Your channel')}</h2><div class="meta">${esc(ch.handle || '')} · ${n(ch.subscribers)} subscribers · ${n(ch.videos)} videos · last ${d.range.days} days (${esc(d.range.startDate)} to ${esc(d.range.endDate)}, Pacific time)</div></div></div>`;
  const kpis = `<div class="kpis">
    ${kpi('Views', n(t.views), changeNote(t.views, p.views))}
    ${kpi('Watch time (hours)', n(t.estimatedMinutesWatched / 60), changeNote(t.estimatedMinutesWatched, p.estimatedMinutesWatched))}
    ${kpi('Avg view duration', Number.isFinite(t.averageViewDuration) ? dur(t.averageViewDuration) : '—', changeNote(t.averageViewDuration, p.averageViewDuration))}
    ${kpi('Avg % viewed', Number.isFinite(t.averageViewPercentage) ? `${t.averageViewPercentage.toFixed(1)}%` : '—', changeNote(t.averageViewPercentage, p.averageViewPercentage))}
    ${kpi('Net subscribers', signed(netSubs(t)), changeNote(netSubs(t), netSubs(p)))}
    ${kpi('Likes', n(t.likes), changeNote(t.likes, p.likes))}
    ${kpi('Comments', n(t.comments), changeNote(t.comments, p.comments))}
    ${kpi('Shares', n(t.shares), changeNote(t.shares, p.shares))}
    ${d.revenue ? kpi('Estimated revenue', `$${num(d.revenue.estimatedRevenue, 2)}`, `CPM $${num(d.revenue.cpm, 2)} · playback CPM $${num(d.revenue.playbackBasedCpm, 2)}`) : ''}
  </div>`;
  const daily = (d.daily || []).map((r) => ({ t: Date.parse(r.day), views: r.views, subs: r.subscribersGained - r.subscribersLost }));
  const traffic = d.traffic ? hbars(d.traffic.slice(0, 10).map((r) => ({ label: r.label, value: r.views })), { fmt: (x) => n(x) }) : '';
  const trafficShare = d.traffic ? `<p class="hint">${d.traffic.slice(0, 3).map((r) => `${esc(r.label)} ${pct(r.share, 0)}`).join(' · ')}</p>` : '';
  const terms = d.searchTerms?.length ? `<div class="table-wrap"><table><thead><tr><th class="l">Search term</th><th>Views</th><th>Watch hours</th></tr></thead><tbody>
      ${d.searchTerms.map((r) => `<tr><td class="l"><button class="linkish to-keyword" data-kw="${esc(r.insightTrafficSourceDetail)}">${esc(r.insightTrafficSourceDetail)}</button></td><td>${n(r.views)}</td><td>${n(r.estimatedMinutesWatched / 60)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No YouTube search traffic in this period.</p>';
  const ages = {};
  const genders = {};
  for (const r of d.demographics || []) {
    ages[r.ageGroup] = (ages[r.ageGroup] || 0) + r.viewerPercentage;
    genders[r.gender] = (genders[r.gender] || 0) + r.viewerPercentage;
  }
  const ageLabel = (a) => a.replace('age', '').replace(/-$/, '+');
  const demo = Object.keys(ages).length
    ? `${hbars(Object.entries(ages).sort().map(([k, v]) => ({ label: ageLabel(k), value: v })), { fmt: (x) => `${x.toFixed(1)}%` })}
       <p class="hint">${Object.entries(genders).map(([g, v]) => `${esc(g === 'user_specified' ? 'user-specified' : g)} ${v.toFixed(1)}%`).join(' · ')}</p>`
    : '<p class="muted">YouTube hides demographics when there are too few viewers.</p>';
  const geo = d.geography?.length ? hbars(d.geography.slice(0, 10).map((r) => ({ label: r.country === 'ZZ' ? 'Unknown' : r.country, value: r.views })), { fmt: (x) => n(x) }) : '<p class="muted">No data.</p>';
  const top = d.topVideos?.length ? `<div class="table-wrap"><table><thead><tr><th class="l">Video</th><th>Views</th><th>Watch hours</th><th>Avg duration</th><th>Avg % viewed</th><th>Subs gained</th><th></th></tr></thead><tbody>
      ${d.topVideos.map((v) => `<tr><td class="l wrap"><a href="${ytVideo(v.video)}" target="_blank" rel="noopener">${esc(v.title)}</a></td><td>${n(v.views)}</td><td>${n(v.estimatedMinutesWatched / 60)}</td>
        <td>${dur(v.averageViewDuration)}</td><td>${num(v.averageViewPercentage)}%</td><td>${n(v.subscribersGained)}</td>
        <td><button class="ghost retention" data-id="${esc(v.video)}">Retention</button></td></tr>`).join('')}</tbody></table></div><div id="retention-out"></div>`
    : '<p class="muted">No views in this period.</p>';
  const errs = Object.entries(d.errors || {});
  return `${card('My channel', '', head + kpis, '<button class="ghost" id="disconnect">Disconnect</button>')}
    <div class="stack">
    ${errs.length ? `<div class="error">Some reports could not be loaded: ${errs.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</div>` : ''}
    <div class="grid-2">
      ${card('Daily views', '', lineChart(daily.map((r) => ({ t: r.t, v: r.views })), { label: 'Daily views', minZero: true }))}
      ${card('Daily net subscribers', '', lineChart(daily.map((r) => ({ t: r.t, v: r.subs })), { label: 'Daily net subscribers', fmtY: (x) => signed(x) }))}
    </div>
    <div class="grid-2">
      ${card('Traffic sources', 'Where your views came from.', traffic + trafficShare)}
      ${card('YouTube search terms', 'The searches that brought viewers to your videos (top 25). Click one to research it.', terms)}
    </div>
    ${card('Top videos', 'Click Retention to see where viewers drop off.', top)}
    <div class="grid-2">
      ${card('Audience age', '% of signed-in viewers.', demo)}
      ${card('Top countries', 'By views.', geo)}
    </div>
    <p class="hint">Impressions and click-through rate are not available in the YouTube Analytics API; check those in YouTube Studio.</p>
    </div>`;
}

async function loadMe() {
  const out = $('#out-me');
  out.innerHTML = loading('Loading your channel analytics…');
  try {
    const d = await api('me', {});
    if (!d.connected) { out.innerHTML = renderMeSetup(d); return; }
    out.innerHTML = renderMe(d);
    $('#disconnect').addEventListener('click', async () => {
      if (!confirm('Disconnect your Google account from TubeScout?')) return;
      await apiPost('/auth/logout', {}).catch((err) => alert(err.message));
      loadMe();
    });
    out.querySelectorAll('.to-keyword').forEach((b) => b.addEventListener('click', () => {
      setTab('keyword');
      $('#keyword-input').value = b.dataset.kw;
      $('#form-keyword').requestSubmit();
    }));
    out.querySelectorAll('.retention').forEach((b) => b.addEventListener('click', async () => {
      const box = $('#retention-out');
      box.innerHTML = loading('Loading retention…');
      try {
        const r = await api('me/retention', { video: b.dataset.id });
        const pts = r.points.map((p) => ({ t: p.elapsedVideoTimeRatio, v: p.audienceWatchRatio }));
        const rel = r.points.map((p) => p.relativeRetentionPerformance).filter(Number.isFinite);
        const relAvg = rel.length ? rel.reduce((a, x) => a + x, 0) / rel.length : null;
        box.innerHTML = `<h3 class="sub-h" style="margin-top:16px">Audience retention: ${esc(r.title)}</h3>
          ${lineChart(pts, { fmtX: (x) => `${Math.round(x * 100)}%`, fmtY: (y) => `${Math.round(y * 100)}%`, label: 'Audience retention', minZero: true })}
          <p class="hint">X axis: how far into the video. Y axis: share of viewers still watching (can exceed 100% where people rewatch).
          ${relAvg !== null ? `Average relative retention vs similar-length YouTube videos: <b>${relAvg.toFixed(2)}</b> (0.5 = typical).` : ''}</p>`;
      } catch (err) { box.innerHTML = errorBox(err.message); }
    }));
  } catch (err) { out.innerHTML = errorBox(err.message); }
}

// ---------- feature tabs (public/features/*.js) ----------
const loaders = { tracking: loadTracking, me: loadMe };

/**
 * Register a feature tab. opts: { id, label, before?: tabId, onShow(container) }.
 * Creates the nav button and <section id="tab-{id}"><div id="out-{id}"></div></section>.
 * onShow runs every time the tab is opened; it may return a Promise.
 */
function registerTab({ id, label, before, onShow }) {
  if (!/^[a-z][\w-]*$/.test(id) || document.getElementById(`tab-${id}`)) throw new Error(`Bad or duplicate tab id: ${id}`);
  const btn = document.createElement('button');
  btn.setAttribute('role', 'tab');
  btn.dataset.tab = id;
  btn.setAttribute('aria-selected', 'false');
  btn.textContent = label;
  const nav = document.querySelector('.tabs');
  const ref = before ? nav.querySelector(`[data-tab="${before}"]`) : null;
  nav.insertBefore(btn, ref);
  const section = document.createElement('section');
  section.id = `tab-${id}`;
  section.className = 'tab-panel';
  section.hidden = true;
  section.innerHTML = `<div id="out-${id}"></div>`;
  const refSection = before ? document.getElementById(`tab-${before}`) : null;
  document.querySelector('main').insertBefore(section, refSection);
  btn.addEventListener('click', () => setTab(id));
  if (onShow) loaders[id] = () => onShow(document.getElementById(`out-${id}`));
  btn.addEventListener('click', () => loaders[id]?.());
}

// Shared helpers for feature modules (they are plain ES modules loaded below).
window.TubeScout = {
  $, esc, n, pct, fx, num, ago, dur, signed, shortDate, safeImg, ytVideo, ytChannel,
  card, kpi, hbars, columns, lineChart, videoGrid, keywordTable, tagCloud, titlePatternTable,
  loading, errorBox, api, apiPost, download, toCsv, makeSortable, store, state, setTab, registerTab,
  goToKeyword(q) { setTab('keyword'); $('#keyword-input').value = q; $('#form-keyword').requestSubmit(); },
  /** Deep-link params from the URL hash, e.g. /#tab=audit&video=VIDEO_ID (read by feature tabs on load). */
  deepLink: new URLSearchParams(location.hash.startsWith('#tab=') ? location.hash.slice(1) : ''),
};

const FEATURE_MODULES = ['./features/ai.js', './features/audit.js', './features/ranks.js', './features/alerts.js'];

// ---------- init ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => loaders[b.dataset.tab]?.()));

$('#compare-input').value = store.get('compare') || '';
$('#channel-input').value = store.get('channel') || '';
$('#keyword-input').value = store.get('keyword') || '';

(async () => {
  // A broken feature module must not take the whole app down.
  for (const m of FEATURE_MODULES) {
    try { await import(m); } catch (err) { console.error(`Failed to load ${m}:`, err); }
  }
  const hashErr = /^#me-error=(.*)$/.exec(location.hash);
  let initialTab = store.get('tab') || 'compare';
  if (!document.getElementById(`tab-${initialTab}`)) initialTab = 'compare';
  if (location.hash.startsWith('#me')) initialTab = 'me';
  const link = window.TubeScout.deepLink;
  if (link.get('tab') && document.getElementById(`tab-${link.get('tab')}`)) initialTab = link.get('tab');
  setTab(initialTab);
  // Built-in tabs that take a query: #tab=compare|channel|keyword&q=...
  const q = link.get('q');
  if (q && ['compare', 'channel', 'keyword'].includes(initialTab)) {
    $(`#${initialTab}-input`).value = q;
    $(`#form-${initialTab}`).requestSubmit();
  }
  await Promise.resolve(loaders[initialTab]?.()).catch(() => {});
  if (hashErr) $('#out-me').insertAdjacentHTML('afterbegin', errorBox(`Google sign-in failed: ${decodeURIComponent(hashErr[1])}`));
  if (location.hash) history.replaceState(null, '', location.pathname);
})();
api('status', {}).then(updateMeta).catch(() => {});
