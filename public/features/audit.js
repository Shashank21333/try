// Feature tab: Audit. Video SEO score + channel audit (in the spirit of vidIQ's scorecard/channel
// audit and TubeBuddy's SEO Studio/health report). Uses helpers from window.TubeScout (public/app.js).
// SECURITY: every API/YouTube/user string goes through esc(); images through safeImg(); links via ytVideo/ytChannel.
const T = window.TubeScout;
const { $, esc, n, pct, fx, ago, dur, safeImg, ytVideo, ytChannel, card, kpi } = T;

const CSS = `
#ac-out { scroll-margin-top: 130px; } /* clear the sticky header */
.ac-forms { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 18px; margin-bottom: 20px; }
.ac-forms .search { margin-bottom: 0; display: flex; flex-direction: column; }
.ac-forms .search .hint { margin-top: auto; padding-top: 8px; }
.ac-head { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 14px; }
.ac-thumb { width: 200px; max-width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; display: block; background: var(--surface-2); }
.ac-avatar { width: 56px; height: 56px; border-radius: 50%; flex: none; }
.ac-head-text { flex: 1 1 240px; min-width: 0; }
.ac-head h2 { font-size: 17px; margin: 0 0 4px; overflow-wrap: anywhere; }
.ac-head h2 a { text-decoration: none; }
.ac-head h2 a:hover { text-decoration: underline; }
.ac-head .meta { color: var(--muted); font-size: 13px; margin-bottom: 6px; overflow-wrap: anywhere; }
.ac-score { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
.ac-score > .kpis, .ac-score > .gauges { flex: 1 1 300px; }
.ac-score > .gauges { grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); } /* 2 per row on phones */
.ac-ring { position: relative; width: 128px; height: 128px; flex: none; }
.ac-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); display: block; }
.ac-ring circle { fill: none; stroke-width: 9; }
.ac-ring .bg { stroke: var(--surface-2); }
.ac-ring .fg { stroke-linecap: round; }
.ac-ring .fg.good { stroke: var(--good); } .ac-ring .fg.mid { stroke: var(--bar); } .ac-ring .fg.bad { stroke: var(--bad); }
.ac-ring-num { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ac-ring-num b { font-size: 32px; line-height: 1; font-variant-numeric: tabular-nums; }
.ac-ring-num span { font-size: 12.5px; color: var(--muted); margin-top: 4px; font-weight: 600; }
.ac-checks { list-style: none; margin: 0 0 14px; padding: 0; }
.ac-checks:last-child { margin-bottom: 0; }
.ac-check { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 2px 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.ac-check:last-child { border-bottom: 0; }
.ac-mark { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: var(--surface); background: var(--bar-2); margin-top: 1px; }
.ac-check.pass .ac-mark { background: var(--good); }
.ac-check.fail .ac-mark { background: var(--bad); }
.ac-check.part .ac-mark { background: var(--bar); }
.ac-label { font-weight: 600; overflow-wrap: anywhere; }
.ac-kind { display: inline-block; font-size: 10.5px; font-weight: 600; border: 1px solid var(--border); color: var(--muted); border-radius: 4px; padding: 0 5px; margin-left: 6px; vertical-align: 1px; white-space: nowrap; }
.ac-kind.rule { border-color: var(--bar); color: var(--bar); }
.ac-detail { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.ac-fix { font-size: 12.5px; margin-top: 3px; overflow-wrap: anywhere; }
.ac-pts { font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.ac-grade { display: inline-block; min-width: 2.4em; text-align: center; border-radius: 5px; padding: 0 5px; font-weight: 700; font-size: 12.5px; }
.ac-grade.good { color: var(--good); background: color-mix(in srgb, var(--good) 14%, transparent); }
.ac-grade.mid { color: var(--bar); background: color-mix(in srgb, var(--bar) 14%, transparent); }
.ac-grade.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, transparent); }
td.ac-issues { white-space: normal; min-width: 190px; color: var(--muted); font-size: 12.5px; text-align: left; }
.ac-recs { margin: 0; padding-left: 22px; display: grid; gap: 8px; }
.ac-recs li { overflow-wrap: anywhere; }
.ac-row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
`;

function injectStyles() {
  if (document.getElementById('audit-style')) return;
  const style = document.createElement('style');
  style.id = 'audit-style';
  style.textContent = CSS;
  document.head.append(style);
}

// ---------- small render helpers ----------
const tone = (grade) => (grade === 'A' || grade === 'B' ? 'good' : grade === 'C' ? 'mid' : 'bad');
const clampScore = (x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0)));
const daysSince = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86_400_000) : null; };

function ring(score, grade, caption) {
  const s = clampScore(score);
  const R = 44, C = 2 * Math.PI * R;
  return `<div class="ac-ring" role="img" aria-label="${esc(caption)}: ${s} out of 100, grade ${esc(grade)}">
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="bg" cx="50" cy="50" r="${R}"/>
      <circle class="fg ${tone(grade)}" cx="50" cy="50" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - s / 100)).toFixed(1)}"/></svg>
    <div class="ac-ring-num" aria-hidden="true"><b>${s}</b><span>Grade ${esc(grade)}</span></div></div>`;
}

const KIND = {
  rule: ['Official rule', 'Enforces a documented YouTube requirement'],
  heuristic: ['Heuristic', 'A best-practice rule of thumb, not a YouTube rule'],
};

function checkItem(c) {
  const state = c.info ? 'info' : c.passed ? 'pass' : c.points > 0 ? 'part' : 'fail';
  const [mark, srText] = { pass: ['✓', 'Passed'], fail: ['✗', 'Failed'], part: ['!', 'Partly passed'], info: ['i', 'Information'] }[state];
  const [kindLabel, kindTitle] = KIND[c.kind] || KIND.heuristic;
  return `<li class="ac-check ${state}">
    <span class="ac-mark" role="img" aria-label="${srText}">${mark}</span>
    <div><div class="ac-label">${esc(c.label)}<span class="ac-kind ${c.kind === 'rule' ? 'rule' : ''}" title="${esc(kindTitle)}">${esc(kindLabel)}</span></div>
      <div class="ac-detail">${esc(c.detail)}</div>
      ${!c.passed && c.fix ? `<div class="ac-fix"><b>Fix:</b> ${esc(c.fix)}</div>` : ''}</div>
    <span class="ac-pts">${c.info ? 'info' : `${Number(c.points) || 0}/${Number(c.maxPoints) || 0}`}</span></li>`;
}

/** Failed first (most points lost first), then passed, then informational items. */
function checklist(checks) {
  const lost = (c) => c.maxPoints - c.points;
  const failed = checks.filter((c) => !c.passed).sort((a, b) => lost(b) - lost(a));
  const passed = checks.filter((c) => c.passed && !c.info);
  const info = checks.filter((c) => c.info);
  const group = (title, list) => (list.length ? `<h3 class="sub-h">${title} (${list.length})</h3><ul class="ac-checks">${list.map(checkItem).join('')}</ul>` : '');
  return group('Needs work', failed) + group('Passed', passed) + group('For information', info) || '<p class="muted">No checks apply.</p>';
}

const demoNote = () => (T.state.meta?.mode === 'demo' ? ' · <b>synthetic demo data</b>' : '');

// ---------- video audit ----------
function renderVideo(d, keyword) {
  const v = d.video, c = d.channel, s = d.seo;
  const base = c ? (v.isShort ? c.medianViewsShorts : c.medianViewsLong) : null;
  const fmt = v.isShort ? 'Short' : 'long-form';
  const head = `<div class="ac-head">
      ${safeImg(v.thumbnail) ? `<a href="${ytVideo(v.id)}" target="_blank" rel="noopener"><img class="ac-thumb" src="${safeImg(v.thumbnail)}" alt=""></a>` : ''}
      <div class="ac-head-text">
        <h2><a href="${ytVideo(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></h2>
        <div class="meta">${v.channelId ? `<a href="${ytChannel(v.channelId)}" target="_blank" rel="noopener">${esc(v.channelTitle)}</a>` : esc(v.channelTitle)}
          · ${ago(v.ageDays)} · ${v.isShort ? `Short (${dur(v.durationSec)})` : dur(v.durationSec)}${demoNote()}</div>
        ${keyword ? `<div class="meta">Target keyword: <b>${esc(keyword)}</b></div>` : '<div class="meta">Add a target keyword to also check keyword placement.</div>'}
        ${v.channelId ? `<div class="ac-row-actions"><button type="button" class="ghost" data-audit-channel="${esc(v.channelId)}">Audit this channel</button></div>` : ''}
      </div></div>`;
  const score = `<div class="ac-score">${ring(s.score, s.grade, 'Video SEO score')}<div class="kpis">
      ${kpi('Views', n(v.views))}
      ${kpi('Views / day', n(v.viewsPerDay))}
      ${kpi('Engagement', pct(v.engagementRate, 2), '(likes + comments) ÷ views')}
      ${kpi('Outlier score', fx(d.outlierScore), base ? `vs ${n(base)} typical ${fmt} views` : 'no channel baseline')}
      ${kpi('Likes', n(v.likes), v.likes === null ? 'hidden' : '')}
      ${kpi('Comments', n(v.comments), v.comments === null ? 'disabled' : '')}
    </div></div>
    <p class="hint">SEO score = share of available points earned on the checks below (A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, else F).
      "Official rule" checks follow YouTube's documented requirements; "Heuristic" checks are rules of thumb.
      Outlier score = views ÷ the channel's median views for its ${c ? c.sampleSize : 'recent'} most recent uploads of the same format.</p>`;
  const tags = v.tags.length
    ? v.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
    : '<p class="muted">This video has no public tags.</p>';
  return `${card('Video SEO score', '', head + score)}
    <div class="stack">
      ${card('Checklist', 'Failed checks first, with the points each one is worth and how to fix it.', checklist(s.checks))}
      ${card(`Tags (${v.tags.length})`, 'YouTube says tags play a minimal role in discovery; they mainly help with misspellings.', tags)}
    </div>`;
}

// ---------- channel audit ----------
const VIDEO_CSV = [
  { head: 'title', get: (v) => v.title }, { head: 'url', get: (v) => ytVideo(v.id) },
  { head: 'published', get: (v) => v.publishedAt }, { head: 'format', get: (v) => (v.isShort ? 'short' : 'long') },
  { head: 'views', get: (v) => v.views }, { head: 'outlier_score', get: (v) => v.outlierScore?.toFixed(3) },
  { head: 'seo_score', get: (v) => v.seoScore }, { head: 'grade', get: (v) => v.grade },
  { head: 'top_issues', get: (v) => v.topIssues.join('|') },
];

const videoRow = (v) => `<tr>
  <td class="l wrap"><a href="${ytVideo(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></td>
  <td>${ago(daysSince(v.publishedAt))}</td><td>${v.isShort ? 'Short' : 'Long'}</td><td>${n(v.views)}</td>
  <td class="${v.outlierScore >= 2 ? 'pos' : v.outlierScore < 0.5 ? 'neg' : ''}">${fx(v.outlierScore)}</td>
  <td><span class="ac-grade ${tone(v.grade)}" title="Grade ${esc(v.grade)}">${clampScore(v.seoScore)} ${esc(v.grade)}</span></td>
  <td class="ac-issues">${v.topIssues.length ? esc(v.topIssues.join(', ')) : 'None'}</td>
  <td><button type="button" class="ghost" data-audit-video="${esc(v.id)}">Audit</button></td></tr>`;

function renderChannel(d) {
  const c = d.channel;
  const head = `<div class="ac-head">${safeImg(c.thumbnail) ? `<img class="ac-avatar" src="${safeImg(c.thumbnail)}" alt="">` : ''}
    <div class="ac-head-text"><h2><a href="${ytChannel(c.id)}" target="_blank" rel="noopener">${esc(c.title)}</a></h2>
      <div class="meta">${esc(c.handle || '')}${c.subscribers !== null ? ` · ${n(c.subscribers)} subscribers` : ''}
        · audited ${c.sampleSize} ${c.sampleComplete ? '(all)' : 'most recent'} uploads${demoNote()}</div></div></div>`;
  const gauges = `<div class="gauges">${d.sections.map((s) => `<div class="gauge"><div class="label">${esc(s.title)}</div>
      <div class="value">${s.score === null ? '—' : clampScore(s.score)}<span class="muted" style="font-size:14px">/100</span></div>
      <div class="track"><div style="width:${s.score === null ? 0 : clampScore(s.score)}%"></div></div>
      <div class="note">${Number(s.weight) || 0}% of overall score</div></div>`).join('')}</div>`;
  const overview = `<div class="ac-score">${ring(d.score, d.grade, 'Channel audit score')}${gauges}</div>
    <p class="hint">Overall score = weighted average of the section scores. Thresholds are TubeScout's rules of thumb, except checks marked "Official rule". Based on public data only: impressions, click-through rate and watch time need YouTube Studio (see the My channel tab for your own channel).</p>`;

  const recs = d.recommendations.length
    ? `<ol class="ac-recs">${d.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`
    : '<p class="muted">Nothing major to fix. Keep it up.</p>';
  const sectionCards = d.sections.map((s) => card(s.title,
    `Section score ${s.score === null ? '—' : `${clampScore(s.score)}/100`} · ${Number(s.weight) || 0}% of the overall score`,
    checklist(s.checks))).join('');
  const table = d.videos.length ? `<div class="table-wrap"><table id="ac-video-table"><thead><tr>
      <th class="l" data-sort="title">Video</th><th data-sort="publishedAt">Published</th><th data-sort="isShort">Format</th>
      <th data-sort="views">Views</th><th data-sort="outlierScore">Outlier</th><th data-sort="seoScore">SEO score</th>
      <th class="l">Top issues</th><th><span class="muted">Details</span></th></tr></thead>
      <tbody>${d.videos.map(videoRow).join('')}</tbody></table></div>` : '<p class="muted">No public uploads found.</p>';

  return `${card('Channel audit', '', head + overview)}
    <div class="stack">
      ${card('Recommendations', 'Ordered by how much fixing each would raise the overall score.', recs)}
      <div class="grid-2">${sectionCards}</div>
      ${card('Video SEO scores', 'Click a column to sort. "Audit" opens the full checklist for a video.', table,
        d.videos.length ? '<button type="button" class="ghost" id="ac-csv">Export CSV</button>' : '')}
    </div>`;
}

// ---------- wiring ----------
injectStyles();
T.registerTab({ id: 'audit', label: 'Audit', before: 'tracking' });

const root = document.getElementById('out-audit');
root.innerHTML = `
  <div class="ac-forms">
    <form id="ac-video-form" class="search" novalidate>
      <label for="ac-video">Audit a video</label>
      <div class="row"><input id="ac-video" placeholder="Video URL or ID (watch, youtu.be, Shorts)" autocomplete="off" spellcheck="false"></div>
      <div class="row">
        <input id="ac-keyword" placeholder="Target keyword (optional)" autocomplete="off" maxlength="100" aria-label="Target keyword (optional)">
        <button type="submit" class="primary">Audit video</button>
      </div>
      <p class="hint">About 4 API units: the video plus its channel's 50 latest uploads as a baseline (cached 15 min).</p>
    </form>
    <form id="ac-channel-form" class="search" novalidate>
      <label for="ac-channel">Audit a channel</label>
      <div class="row"><input id="ac-channel" placeholder="@handle, channel URL or ID" autocomplete="off" spellcheck="false"></div>
      <div class="row">
        <select id="ac-max" aria-label="Uploads to audit"><option value="50">Last 50 uploads</option><option value="100">Last 100</option><option value="200">Last 200</option></select>
        <button type="submit" class="primary">Audit channel</button>
      </div>
      <p class="hint">About 2 API units per 50 uploads, plus 1–2 for the channel (100 more if it has to be found by name search).</p>
    </form>
  </div>
  <div id="ac-out"></div>`;

const out = $('#ac-out', root);
const videoForm = $('#ac-video-form', root);
const channelForm = $('#ac-channel-form', root);
let seq = 0; // only the latest audit may render

// On small screens the forms fill the viewport, and "Audit" buttons sit far down the table:
// bring the spinner/result into view. A hidden tab reports top 0, so a deep link that runs
// before its tab is shown does not scroll.
function reveal() {
  const top = out.getBoundingClientRect().top;
  if (top < 0 || top > window.innerHeight - 120) out.scrollIntoView({ block: 'start' });
}

async function runAudit(form, message, fn) {
  const token = ++seq;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  out.innerHTML = T.loading(message);
  reveal();
  try {
    const html = await fn();
    if (token === seq) { out.innerHTML = html; reveal(); }
    return token === seq;
  } catch (e) {
    if (token === seq) { out.innerHTML = T.errorBox(e.message); reveal(); }
    return false;
  } finally {
    btn.disabled = false;
  }
}

videoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#ac-video', root).value.trim();
  const keyword = $('#ac-keyword', root).value.trim();
  if (!id) { out.innerHTML = T.errorBox('Enter a video URL or 11-character video ID.'); return; }
  T.store.set('audit-video', id);
  T.store.set('audit-keyword', keyword);
  runAudit(videoForm, 'Auditing video…', async () => renderVideo(await T.api('video', { id, keyword }), keyword));
});

channelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#ac-channel', root).value.trim();
  if (!q) { out.innerHTML = T.errorBox('Enter a channel URL, @handle or channel ID.'); return; }
  T.store.set('audit-channel', q);
  let data;
  const shown = await runAudit(channelForm, 'Auditing channel uploads…', async () => {
    data = await T.api('audit/channel', { q, max: $('#ac-max', root).value });
    return renderChannel(data);
  });
  if (!shown || !data.videos.length) return;
  T.makeSortable($('#ac-video-table', root), data.videos, videoRow);
  $('#ac-csv', root).addEventListener('click', () => T.download(`${data.channel.title.replace(/[^\w-]+/g, '_') || 'channel'}-audit.csv`, T.toCsv(data.videos, VIDEO_CSV)));
});

// Buttons inside results (delegated, so they survive table re-sorts).
out.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-audit-video], button[data-audit-channel]');
  if (!btn) return;
  if (btn.dataset.auditVideo) {
    $('#ac-video', root).value = btn.dataset.auditVideo;
    $('#ac-keyword', root).value = '';
    videoForm.requestSubmit();
  } else {
    $('#ac-channel', root).value = btn.dataset.auditChannel;
    channelForm.requestSubmit();
  }
});

$('#ac-video', root).value = T.store.get('audit-video') || '';
$('#ac-keyword', root).value = T.store.get('audit-keyword') || '';
$('#ac-channel', root).value = T.store.get('audit-channel') || '';

// Deep links: #tab=audit&video=<id or URL>[&keyword=...]  or  #tab=audit&channel=<@handle, URL or ID>
const link = T.deepLink;
if (link.get('tab') === 'audit') {
  if (link.get('video')) {
    $('#ac-video', root).value = link.get('video');
    $('#ac-keyword', root).value = link.get('keyword') || '';
    videoForm.requestSubmit();
  } else if (link.get('channel')) {
    $('#ac-channel', root).value = link.get('channel');
    channelForm.requestSubmit();
  }
}
