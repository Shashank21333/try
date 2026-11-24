// Feature tab: AI Studio. Claude-generated titles, descriptions & tags, video ideas and script
// outlines, grounded in real YouTube data (autocomplete searches + competitor outliers).
// Every string from the API or the user goes through T.esc() before it reaches innerHTML.
const T = window.TubeScout;
const { esc } = T;

const TOOLS = [
  { id: 'titles', label: 'Titles' },
  { id: 'description', label: 'Description & tags' },
  { id: 'ideas', label: 'Video ideas' },
  { id: 'script', label: 'Script outline' },
];
const LANGS = [['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'], ['de', 'German'],
  ['id', 'Indonesian'], ['ar', 'Arabic'], ['ja', 'Japanese'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu']];

// Quota: search.list has its own bucket (default 100 calls a day); other calls share 10,000 units a day.
const COST_NOTE = 'YouTube autocomplete is free. Competitors cost about 4 YouTube API units each (cached 15 min). Use @handles or URLs: a bare channel name also uses one of your 100 daily YouTube search calls (default quota). Each click is one Claude request, billed by Anthropic.';

// ---------- styles (reuse the app's CSS variables) ----------
const style = document.createElement('style');
style.textContent = `
.ai-seg { display: flex; gap: 4px; background: var(--surface-2); padding: 4px; border-radius: 9px; margin: 0 0 16px; }
.ai-seg button { flex: 1 1 auto; border: 0; background: transparent; color: var(--muted); padding: 7px 12px; border-radius: 7px; font: inherit; cursor: pointer; white-space: nowrap; }
.ai-seg button[aria-selected="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
@media (max-width: 640px) { .ai-seg { display: grid; grid-template-columns: 1fr 1fr; } .ai-seg button { white-space: normal; } }
.ai-form > input { width: 100%; }
.ai-form > label:not(:first-child) { margin-top: 12px; }
.ai-form .row select { flex: 0 1 auto; }
.ai-form .row .hint { flex: 1 1 260px; margin: 0; }
.ai-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.ai-item { background: var(--surface-2); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.ai-item-head { display: flex; gap: 10px; align-items: flex-start; }
.ai-item-head .ai-main { flex: 1; min-width: 0; }
.ai-title { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.ai-meta { color: var(--muted); font-size: 12.5px; margin-top: 4px; overflow-wrap: anywhere; }
.ai-meta .tag { margin: 0 6px 0 0; background: var(--surface); }
.ai-score { flex: 0 0 auto; min-width: 40px; text-align: center; font-weight: 700; border-radius: 6px; padding: 2px 6px; font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--bar) 14%, transparent); color: var(--bar); }
.ai-score.hi { background: color-mix(in srgb, var(--good) 14%, transparent); color: var(--good); }
.ai-score.lo { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.ai-checks { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; font-size: 12.5px; }
.ai-checks li { overflow-wrap: anywhere; }
.ai-checks .ok::before { content: "✓ "; color: var(--good); font-weight: 700; }
.ai-checks .no::before { content: "✗ "; color: var(--bad); font-weight: 700; }
.ai-checks .no { color: var(--muted); }
.ai-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ai-text { width: 100%; min-height: 220px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ai-evidence { margin-top: 12px; }
.ai-evidence summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
.ai-evidence ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 4px; font-size: 12.5px; }
.ai-evidence li, .ai-ev li { overflow-wrap: anywhere; }
.ai-ev { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; display: grid; gap: 2px; }
.ai-outline { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
.ai-outline b { display: block; }
.ai-sec + .ai-sec { margin-top: 14px; }
.ai-sec h3 { font-size: 13px; margin: 0 0 6px; }
.ai-sec p { margin: 0; overflow-wrap: anywhere; }
.ai-warn { background: var(--warn-bg); color: var(--warn-ink); border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin-bottom: 12px; }
`;
document.head.appendChild(style);

// ---------- small helpers ----------
const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const langOptions = (sel = 'en') => LANGS.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
const checkList = (checks) => `<ul class="ai-checks">${checks.map((c) => `<li class="${c.passed ? 'ok' : 'no'}">${esc(c.label)}</li>`).join('')}</ul>`;
const scoreClass = (s) => (s >= 80 ? 'hi' : s < 50 ? 'lo' : '');

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* insecure context or denied: fall back */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

function footer(r) {
  const tokens = Number.isFinite(r.usage?.inputTokens) ? ` · ${T.n(r.usage.inputTokens)} input + ${T.n(r.usage.outputTokens)} output tokens (billed by Anthropic)` : '';
  const fb = r.fallbackUsed ? ' · answered by the automatic fallback model after the first model declined' : '';
  return `<p class="hint">Generated by ${esc(r.model || 'Claude')}${fb}${tokens}. AI output can be wrong: review it before publishing.</p>`;
}

function syntheticWarning(g) {
  return g?.synthetic ? '<div class="ai-warn"><b>Demo mode:</b> the competitor videos used as evidence are synthetic, so treat this output as illustrative only. Autocomplete searches are real.</div>' : '';
}

function groundingErrors(g) {
  return g?.errors?.length ? `<p class="hint">Some data could not be loaded: ${g.errors.map(esc).join('; ')}</p>` : '';
}

const sourceText = (g) => ({
  input: `from the ${g.channels.length} channel${g.channels.length === 1 ? '' : 's'} you entered`,
  tracked: `from your ${g.channels.length} tracked channel${g.channels.length === 1 ? '' : 's'}`,
  none: 'none: add competitors (or track channels) for niche-specific grounding',
}[g.channelSource] || '');

function outlierList(outliers) {
  if (!outliers.length) return '';
  return `<p class="hint"><b>Competitor outliers</b> (views vs that channel's typical video):</p><ul>${outliers.map((o) => `
    <li><a href="${esc(T.ytVideo(o.id))}" target="_blank" rel="noopener">${esc(o.title)}</a> <span class="muted">· ${esc(o.channelTitle)} · ${T.fx(o.outlierScore)}${o.isShort ? ' · Short' : ''}</span></li>`).join('')}</ul>`;
}

function searchChips(list) {
  if (!list.length) return '';
  return `<p class="hint"><b>YouTube autocomplete searches</b> (click one to research it):</p><div style="margin-top:6px">${list.map((s) => `<span class="tag idea" role="button" tabindex="0" data-kw="${esc(s)}">${esc(s)}</span>`).join('')}</div>`;
}

// ---------- tool forms ----------
const field = (name) => `ai-${name}`;

function formHtml(id) {
  if (id === 'titles') {
    return `<form class="search ai-form" data-form="titles">
      <label for="${field('t-topic')}">What is the video about?</label>
      <input id="${field('t-topic')}" name="topic" maxlength="500" required placeholder="Choosing a budget phone for students" autocomplete="off">
      <div class="row">
        <input name="keyword" maxlength="100" placeholder="Target keyword (optional)" aria-label="Target keyword" autocomplete="off">
        <input name="region" class="narrow" maxlength="2" placeholder="Region (e.g. IN)" aria-label="Region code" autocomplete="off">
        <select name="hl" aria-label="Language">${langOptions()}</select>
        <select name="count" aria-label="Number of titles"><option value="5">5 titles</option><option value="10" selected>10 titles</option><option value="15">15 titles</option><option value="20">20 titles</option></select>
      </div>
      <label for="${field('t-channels')}">Competitors (optional, one per line, up to 8). Empty = your tracked channels.</label>
      <textarea id="${field('t-channels')}" name="channels" rows="3" placeholder="@competitor1&#10;https://www.youtube.com/@competitor2"></textarea>
      <div class="row"><p class="hint">${esc(COST_NOTE)}</p><button type="submit" class="primary">Generate titles</button></div>
    </form>`;
  }
  if (id === 'description') {
    return `<form class="search ai-form" data-form="description">
      <label for="${field('d-title')}">Video title</label>
      <input id="${field('d-title')}" name="title" maxlength="100" required placeholder="7 Budget Phone Mistakes Students Make" autocomplete="off">
      <div class="row">
        <input name="keyword" maxlength="100" placeholder="Target keyword (optional)" aria-label="Target keyword" autocomplete="off">
        <select name="hl" aria-label="Language">${langOptions()}</select>
      </div>
      <label for="${field('d-summary')}">What does the video cover? (optional, but makes the description specific)</label>
      <textarea id="${field('d-summary')}" name="summary" rows="3" maxlength="2000" placeholder="We compare 5 phones under $300 on camera, battery and updates, and pick one for students."></textarea>
      <label for="${field('d-chapters')}">Your chapters (optional, copied as-is, e.g. "00:00 Intro" one per line)</label>
      <textarea id="${field('d-chapters')}" name="chapters" rows="3" maxlength="2000" placeholder="00:00 Intro&#10;01:10 Camera test&#10;04:30 Battery"></textarea>
      <label for="${field('d-links')}">Your links (optional, one per line, up to 10)</label>
      <textarea id="${field('d-links')}" name="links" rows="2" placeholder="https://example.com/my-gear"></textarea>
      <div class="row"><p class="hint">Claude is told not to write links or timestamps, and TubeScout removes any it finds that you did not type here; yours are added exactly as typed. One Claude request, billed by Anthropic.</p><button type="submit" class="primary">Write description</button></div>
    </form>`;
  }
  if (id === 'ideas') {
    return `<form class="search ai-form" data-form="ideas">
      <label for="${field('i-channels')}">Competitors (one per line, up to 8). Empty = your tracked channels.</label>
      <textarea id="${field('i-channels')}" name="channels" rows="3" placeholder="@competitor1&#10;@competitor2"></textarea>
      <div class="row">
        <input name="keyword" maxlength="100" placeholder="Keyword (optional, e.g. budget phone)" aria-label="Keyword" autocomplete="off">
        <input name="region" class="narrow" maxlength="2" placeholder="Region (e.g. IN)" aria-label="Region code" autocomplete="off">
        <select name="hl" aria-label="Language">${langOptions()}</select>
      </div>
      <div class="row"><p class="hint">Ideas cite their evidence: competitor videos that beat their channel's typical views and real autocomplete searches. ${esc(COST_NOTE)}</p><button type="submit" class="primary">Find video ideas</button></div>
    </form>`;
  }
  return `<form class="search ai-form" data-form="script">
    <label for="${field('s-title')}">Video title</label>
    <input id="${field('s-title')}" name="title" maxlength="100" required placeholder="7 Budget Phone Mistakes Students Make" autocomplete="off">
    <div class="row">
      <input name="audience" maxlength="300" placeholder="Audience (optional, e.g. college students on a budget)" aria-label="Audience" autocomplete="off">
      <label class="inline">Minutes <input name="lengthMinutes" type="number" min="1" max="120" value="8" class="narrow" style="width:80px;flex:0 0 80px" aria-label="Target length in minutes"></label>
      <select name="hl" aria-label="Language">${langOptions()}</select>
    </div>
    <div class="row"><p class="hint">An outline with a hook, beats, call to action and retention tips (not a word-for-word script). One Claude request, billed by Anthropic.</p><button type="submit" class="primary">Outline script</button></div>
  </form>`;
}

function readForm(form) {
  const v = (n) => (form.elements[n]?.value || '').trim();
  const id = form.dataset.form;
  if (id === 'titles') return { topic: v('topic'), keyword: v('keyword'), region: v('region'), hl: v('hl'), count: Number(v('count')), channels: lines(v('channels')) };
  if (id === 'description') return { title: v('title'), keyword: v('keyword'), hl: v('hl'), summary: v('summary'), chapters: form.elements.chapters.value.trim(), links: lines(v('links')) };
  if (id === 'ideas') return { channels: lines(v('channels')), keyword: v('keyword'), region: v('region'), hl: v('hl') };
  return { title: v('title'), audience: v('audience'), lengthMinutes: Number(v('lengthMinutes')) || 8, hl: v('hl') };
}

function fillForm(form, values) {
  for (const [k, val] of Object.entries(values || {})) {
    const el = form.elements[k];
    if (!el || val === undefined || val === null) continue;
    el.value = Array.isArray(val) ? val.join('\n') : String(val);
  }
}

// ---------- result renderers (return { html, copies }) ----------

function renderTitles(r) {
  const g = r.grounding;
  const copies = r.titles.map((t) => t.title);
  copies.push(r.titles.map((t) => t.title).join('\n'));
  const items = r.titles.map((t, i) => `<li class="ai-item">
    <div class="ai-item-head">
      <span class="ai-score ${scoreClass(t.score)}" title="TubeScout title score (heuristic, 0-100)">${t.score}</span>
      <div class="ai-main"><div class="ai-title">${esc(t.title)}</div>
        <div class="ai-meta">${t.angle ? `<span class="tag">${esc(t.angle)}</span>` : ''}${esc(t.why)}</div></div>
      <button type="button" class="ghost" data-copy="${i}">Copy</button>
    </div>
    ${checkList(t.checks)}
  </li>`).join('');
  const patterns = g.patterns.length
    ? `<p class="hint"><b>Niche title patterns</b> (lift = median outlier score with the pattern / without):</p><ul>${g.patterns.map((p) => `<li>${esc(p.label)}: <span class="${p.lift >= 1.15 ? 'pos' : p.lift <= 0.87 ? 'neg' : ''}">${T.fx(p.lift, 2)}</span> <span class="muted">(${T.pct(p.share, 0)} of titles)</span></li>`).join('')}</ul>`
    : '';
  const noKeyword = r.keyword ? '' : ' No target keyword was given, so titles are not checked for one. A short keyword (2-3 words) usually gets more autocomplete searches than a full sentence.';
  const desc = `Based on: <b>${g.ideasUsed.length}</b> autocomplete searches for "${esc(g.searchSeed || r.keyword)}", <b>${g.outliersUsed.length}</b> competitor outliers (${esc(sourceText(g))}), <b>${g.patterns.length}</b> title patterns. Scores are TubeScout heuristics, not YouTube's.${esc(noKeyword)}`;
  const body = `${syntheticWarning(g)}${groundingErrors(g)}
    ${r.titles.length ? `<ol class="ai-list">${items}</ol>` : '<p class="muted">No titles came back. Try again.</p>'}
    <details class="ai-evidence"><summary>Evidence used</summary>${outlierList(g.outliersUsed)}${patterns}${searchChips(g.ideasUsed)}</details>
    ${footer(r)}`;
  return { html: T.card('Title ideas', desc, body, r.titles.length ? `<button type="button" class="ghost" data-copy="${copies.length - 1}">Copy all</button>` : ''), copies };
}

function renderDescription(r) {
  const copies = [null, r.tags.join(', '), r.hashtags.join(' ')]; // index 0 = live textarea value
  const body = `
    <textarea class="ai-text" data-desc aria-label="Generated description (editable)">${esc(r.description)}</textarea>
    <div class="ai-actions"><button type="button" class="ghost" data-copy="0">Copy description</button></div>
    ${checkList(r.checks)}
    <div class="ai-sec" style="margin-top:14px"><h3>Tags <span class="muted">(${r.tagChars} / ${r.tagLimit} characters)</span></h3>
      <div>${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">None</span>'}</div>
      <div class="ai-actions"><button type="button" class="ghost" data-copy="1">Copy tags</button></div>
      <p class="hint">YouTube says tags play a minimal role in discovery (they mostly help with common misspellings); the title, thumbnail and description matter more.</p></div>
    <div class="ai-sec"><h3>Hashtags</h3>
      <div>${r.hashtags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">None</span>'}</div>
      <div class="ai-actions"><button type="button" class="ghost" data-copy="2">Copy hashtags</button></div>
      <p class="hint">Already appended to the description. YouTube shows up to 3 hashtags by the title.</p></div>
    ${footer(r)}`;
  return { html: T.card('Description, tags & hashtags', 'Edit the text below before copying. Your chapters and links are copied exactly as you typed them.', body), copies };
}

function renderIdeas(r) {
  const g = r.grounding;
  const copies = r.ideas.map((i) => `${i.title}\nHook: ${i.hook}`);
  const ev = (e) => (e.type === 'outlier'
    ? `<li>Outlier: <a href="${esc(T.ytVideo(e.videoId))}" target="_blank" rel="noopener">${esc(e.text)}</a> <span class="muted">· ${esc(e.channelTitle)} · ${T.fx(e.outlierScore)} typical</span></li>`
    : `<li>Search: <button type="button" class="linkish" data-kw="${esc(e.text)}">“${esc(e.text)}”</button></li>`);
  const items = r.ideas.map((idea, i) => `<li class="ai-item">
    <div class="ai-item-head">
      <div class="ai-main"><div class="ai-title">${esc(idea.title)} <span class="badge">${idea.format === 'short' ? 'Short' : 'Long-form'}</span></div>
        <div class="ai-meta"><b>Hook:</b> ${esc(idea.hook)}</div>
        <div class="ai-meta">${esc(idea.why)}</div></div>
      <button type="button" class="ghost" data-copy="${i}">Copy</button>
    </div>
    ${idea.evidence.length ? `<ul class="ai-ev">${idea.evidence.map(ev).join('')}</ul>` : '<p class="hint">No linked evidence: treat this one as a hunch.</p>'}
    <div class="ai-actions">
      <button type="button" class="ghost" data-goto="titles" data-value="${esc(idea.title)}">Write titles</button>
      <button type="button" class="ghost" data-goto="script" data-value="${esc(idea.title)}">Outline script</button>
    </div>
  </li>`).join('');
  const seed = g.seedKeyword ? ` for "${esc(g.seedKeyword)}"${g.seedFromCompetitors ? ' (most common word in competitor titles)' : ''}` : '';
  const desc = `Based on: <b>${g.searchesUsed.length}</b> autocomplete searches${seed}, <b>${g.outliersUsed.length}</b> competitor outliers (${esc(sourceText(g))}).`;
  const body = `${syntheticWarning(g)}${groundingErrors(g)}
    ${r.ideas.length ? `<ol class="ai-list">${items}</ol>` : '<p class="muted">No ideas came back. Try again.</p>'}
    <details class="ai-evidence"><summary>All evidence given to Claude</summary>${outlierList(g.outliersUsed)}${searchChips(g.searchesUsed)}</details>
    ${footer(r)}`;
  return { html: T.card('Video ideas', desc, body), copies };
}

function renderScript(r) {
  const text = [
    r.title, '', `HOOK: ${r.hook}`, '',
    ...r.outline.map((b, i) => `${i + 1}. ${b.beat}\n   ${b.details}`), '',
    `CTA: ${r.cta}`, '', 'Retention tips:', ...r.retentionTips.map((t) => `- ${t}`),
  ].join('\n');
  const body = `
    <div class="ai-sec"><h3>Hook (first 10-20 seconds)</h3><p>${esc(r.hook)}</p></div>
    <div class="ai-sec"><h3>Outline (~${r.lengthMinutes} min)</h3><ol class="ai-outline">${r.outline.map((b) => `<li><b>${esc(b.beat)}</b>${esc(b.details)}</li>`).join('')}</ol></div>
    <div class="ai-sec"><h3>Call to action</h3><p>${esc(r.cta)}</p></div>
    <div class="ai-sec"><h3>Retention tips</h3><ul class="ai-outline">${r.retentionTips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    ${footer(r)}`;
  return { html: T.card(`Script outline: ${r.title}`, '[ADD: ...] marks places where you need your own facts.', body, '<button type="button" class="ghost" data-copy="0">Copy outline</button>'), copies: [text] };
}

const RENDER = { titles: renderTitles, description: renderDescription, ideas: renderIdeas, script: renderScript };
const ENDPOINT = { titles: 'ai/titles', description: 'ai/description', ideas: 'ai/ideas', script: 'ai/script' };

// ---------- studio ----------

function setupCard(status) {
  const steps = status?.enabled && !status?.sdkInstalled
    ? `<ol class="steps"><li>In the TubeScout folder, run <code>npm install</code> (installs the official Anthropic SDK).</li><li>Restart TubeScout.</li></ol>`
    : `<ol class="steps">
        <li>Create an API key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>.</li>
        <li>Add <code>ANTHROPIC_API_KEY=your-key</code> to the <code>.env</code> file next to <code>server.js</code>.</li>
        <li>Run <code>npm install</code> in the TubeScout folder (installs the official Anthropic SDK).</li>
        <li>Restart TubeScout.</li>
      </ol>`;
  return T.card('Set up AI Studio',
    'Generate titles, descriptions & tags, video ideas and script outlines with Claude, grounded in real YouTube data (autocomplete searches and competitor outlier videos).',
    `${steps}<p class="hint">Each generation is one Claude API request, billed by Anthropic to your account per token. Default model: <code>${esc(status?.model || 'claude-opus-5-5')}</code> (change it with <code>AI_MODEL</code>). Signed in with <code>ant auth login</code> instead of a key? Set <code>AI_ENABLED=1</code>.</p>`);
}

function renderStudio(el, status) {
  el.innerHTML = `
    <div class="ai-seg" role="tablist" aria-label="AI tools">${TOOLS.map((t) => `<button type="button" role="tab" data-tool="${t.id}" aria-selected="false">${esc(t.label)}</button>`).join('')}</div>
    ${TOOLS.map((t) => `<div class="ai-panel" data-panel="${t.id}" hidden>${formHtml(t.id)}<div class="ai-out" aria-live="polite"></div></div>`).join('')}
    <p class="hint">Model: <code>${esc(status.model)}</code>. If Claude declines a request, the API automatically retries it on a fallback model.</p>`;

  // The server gives up on Claude after status.timeoutSeconds (retries included).
  const mins = Math.round((Number(status.timeoutSeconds) || 0) / 60);
  const waitNote = `This usually takes under a minute${mins ? ` (TubeScout stops waiting after ${mins} minutes)` : ''}.`;

  const show = (id) => {
    const tool = TOOLS.some((t) => t.id === id) ? id : 'titles';
    el.querySelectorAll('.ai-seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tool === tool)));
    el.querySelectorAll('.ai-panel').forEach((p) => { p.hidden = p.dataset.panel !== tool; });
    T.store.set('ai-tool', tool);
    return el.querySelector(`.ai-panel[data-panel="${tool}"]`);
  };
  el.querySelectorAll('.ai-seg button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tool)));

  for (const panel of el.querySelectorAll('.ai-panel')) {
    const id = panel.dataset.panel;
    const form = panel.querySelector('form');
    const out = panel.querySelector('.ai-out');
    let copies = [];
    try { fillForm(form, JSON.parse(T.store.get(`ai-form-${id}`) || '{}')); } catch { /* ignore bad saved state */ }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      if (btn.disabled) return;
      const body = readForm(form);
      T.store.set(`ai-form-${id}`, JSON.stringify(body));
      btn.disabled = true;
      out.innerHTML = T.loading(`${id === 'description' || id === 'script' ? 'Asking Claude…' : 'Collecting YouTube data and asking Claude…'} ${waitNote}`);
      try {
        const r = await T.apiPost(ENDPOINT[id], body);
        const rendered = RENDER[id](r);
        copies = rendered.copies;
        out.innerHTML = rendered.html;
      } catch (err) {
        out.innerHTML = T.errorBox(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    out.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        const i = Number(copyBtn.dataset.copy);
        const text = copies[i] ?? out.querySelector('[data-desc]')?.value ?? '';
        copyText(text, copyBtn);
        return;
      }
      const kw = e.target.closest('[data-kw]');
      if (kw) { T.goToKeyword(kw.dataset.kw); return; }
      const go = e.target.closest('[data-goto]');
      if (go) {
        const target = show(go.dataset.goto);
        const input = target.querySelector(go.dataset.goto === 'titles' ? '[name="topic"]' : '[name="title"]');
        input.value = go.dataset.value.slice(0, Number(input.maxLength) > 0 ? input.maxLength : 500);
        input.focus();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    out.addEventListener('keydown', (e) => {
      const kw = e.target.closest('[data-kw]');
      if (kw && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); T.goToKeyword(kw.dataset.kw); }
    });
  }

  // Deep link (#tab=ai&tool=titles&topic=...): prefill only; never auto-generate, since every generation is billed.
  const link = T.deepLink;
  let start = T.store.get('ai-tool') || 'titles';
  if (link.get('tab') === 'ai') {
    if (link.get('tool')) start = link.get('tool');
    const panel = el.querySelector(`.ai-panel[data-panel="${TOOLS.some((t) => t.id === start) ? start : 'titles'}"]`);
    const form = panel.querySelector('form');
    for (const k of ['topic', 'title', 'keyword']) if (link.get(k) && form.elements[k]) form.elements[k].value = link.get(k).slice(0, 500);
  }
  show(start);
}

T.registerTab({
  id: 'ai',
  label: 'AI Studio',
  before: 'tracking',
  async onShow(el) {
    if (el.dataset.ready === '1') return; // keep forms and results when switching tabs
    el.innerHTML = T.loading('Checking AI setup…');
    try {
      const status = await T.api('ai/status', {});
      if (!status.enabled || !status.sdkInstalled) { el.innerHTML = setupCard(status); return; }
      renderStudio(el, status);
      el.dataset.ready = '1';
    } catch (err) {
      el.innerHTML = T.errorBox(err.message);
    }
  },
});
