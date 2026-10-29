/* lexis studio frontend — no build step, no dependencies */
'use strict';

const $ = (id) => document.getElementById(id);

/** The chapter stages, in pipeline order, as the matrix shows them. */
const STAGES = [
  ['summarize', 'Summary'],
  ['lexicon', 'Lexicon'],
  ['glossary', 'Glossary'],
  ['draft', 'Draft'],
  ['stray', 'Stray'],
  ['critique', 'Critique'],
  ['final', 'Final'],
  ['verify', 'Verify'],
];
const GLOBAL_STAGES = [
  ['prepare', 'Prepare'],
  ['metadata', 'Metadata'],
  ['style', 'Style guide'],
  ['charter', 'Charter'],
  ['package', 'Package'],
];
const STAGE_LABEL = Object.fromEntries([...STAGES, ...GLOBAL_STAGES]);
const RERUN_STAGES = [
  ['final', 'polish only (final)'],
  ['critique', 'fresh critique + polish'],
  ['draft', 'retranslate from scratch'],
];

const state = {
  projects: [],
  current: null, // ProjectMeta
  ws: null,
  lastSeq: 0,
  pipeline: null, // { run, config, chapters, steps, progress }
  feedFilter: '', // chapter key, or ''
  reviewPending: false,
  signedIn: false,
};

/* ---------------- api helpers ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  // A wrong password or passkey answers 401 too; only other 401s mean the session ended.
  if (res.status === 401 && !/^\/api\/auth\/(password|passkey\/|stepup\/)/.test(path)) {
    showLogin('Your session ended. Sign in again.');
    throw new Error('Signed out. Sign in again.');
  }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch { /* ignore */ }
    const err = new Error(body.error ?? res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

const send = (method) => (path, body) =>
  api(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
const post = send('POST');
const put = send('PUT');
const patch = send('PATCH');
const del = (path) => api(path, { method: 'DELETE' });

const projectApi = (p) => `/api/projects/${state.current.id}${p}`;

function fmtDuration(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const fmtCost = (usd) => (usd == null ? '' : `$${Number(usd).toFixed(2)}`);

/* ---------------- project list ---------------- */

async function refreshProjects() {
  // Called in the background from many places: a dropped request just waits for the next refresh.
  try { state.projects = await api('/api/projects'); } catch { return; }
  const list = $('project-list');
  list.innerHTML = '';
  for (const p of state.projects) {
    const el = document.createElement('div');
    el.className = 'project-item' + (state.current?.id === p.id ? ' active' : '');
    el.innerHTML = `
      <div class="p-name"></div>
      <div class="p-sub"><span class="chip status" data-status="${p.status}">${label(p.status)}</span><span class="p-lang"></span></div>`;
    el.querySelector('.p-name').textContent = p.name;
    el.querySelector('.p-lang').textContent = p.targetLanguage;
    el.addEventListener('click', () => selectProject(p.id).catch((e) => alert(e.message)));
    list.appendChild(el);
  }
}

function label(status) {
  return {
    created: 'new',
    running: 'running',
    paused: 'paused',
    awaiting_review: 'review',
    awaiting_input: 'idle',
    completed: 'done',
    error: 'error',
  }[status] ?? status;
}

/* ---------------- project selection ---------------- */

async function selectProject(id) {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  const detail = await api(`/api/projects/${id}`);
  state.current = detail;
  state.lastSeq = 0;
  state.pipeline = await api(`/api/projects/${id}/pipeline`);
  state.feedFilter = '';
  state.reviewPending = false;

  $('empty-state').classList.add('hidden');
  $('project-view').classList.remove('hidden');
  $('project-title').textContent = detail.name;
  $('project-lang').textContent = detail.targetLanguage;
  $('feed').innerHTML = '';
  $('feed-filter').value = '';
  $('review-banner').classList.add('hidden');
  runNotice(null);

  renderVersions(detail.versions ?? []);
  renderUsage(state.pipeline.usage ?? detail.usage);
  renderRun();
  renderMatrix();
  renderStatus();
  closeAsset();
  closeStep();
  if (!$('tab-files').classList.contains('hidden')) loadFiles();
  refreshProjects();
  connectWs();
}

function connectWs() {
  if (!state.current) return;
  const projectId = state.current.id;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?project=${projectId}&after=${state.lastSeq}`);
  state.ws = ws;
  ws.onmessage = (msg) => {
    try { handleEvent(JSON.parse(msg.data)); } catch (e) { console.error(e); }
  };
  ws.onclose = (ev) => {
    if (ev.code === 4001) { showLogin(); return; }
    if (state.current?.id === projectId) setTimeout(connectWs, 1500);
  };
}

/* ---------------- event handling ---------------- */

function handleEvent(ev) {
  if (ev.seq <= state.lastSeq) return;
  state.lastSeq = ev.seq;
  switch (ev.type) {
    case 'status':
      if (state.current) state.current.status = ev.data.status;
      renderStatus();
      refreshProjects();
      refreshDetail();
      if (ev.data.detail) addFeed(ev, 'progress', ev.data.detail);
      break;
    case 'plan':
      if (state.pipeline) {
        state.pipeline.chapters = ev.data.chapters;
        state.pipeline.config = ev.data.config;
        renderMatrix();
        renderRun();
      }
      break;
    case 'step':
      if (state.pipeline) {
        state.pipeline.steps[ev.data.step.id] = ev.data.step;
        renderCell(ev.data.step);
        if (stepModal.id === ev.data.step.id) renderStepModal(ev.data.step);
      }
      break;
    case 'run':
      if (state.pipeline) {
        state.pipeline.run = ev.data.run;
        state.pipeline.progress = ev.data.progress;
        if (ev.data.run.state !== 'awaiting_review') {
          state.reviewPending = false;
          $('review-banner').classList.add('hidden');
        }
        renderRun();
        renderStatus();
      }
      break;
    case 'agent_text':
      addFeed(ev, 'text', ev.data.text);
      break;
    case 'thinking':
      addFeed(ev, 'thinking', ev.data.text, { collapse: 240 });
      break;
    case 'tool_use':
      addToolFeed(ev);
      break;
    case 'review_request':
      showReview(ev.data.summary, ev.data.warnings ?? []);
      addFeed(ev, 'task', '⏸ review requested — see the banner above');
      break;
    case 'review_response':
      addFeed(ev, 'text', ev.data.decision === 'approve'
        ? '✓ Approved — packaging.'
        : `↺ Another pass (${ev.data.chapters?.length ?? 'all'} chapters, from ${STAGE_LABEL[ev.data.from] ?? ev.data.from}): ${ev.data.instructions ?? ''}`);
      break;
    case 'user_message':
      addFeed(ev, 'text', ev.data.text);
      break;
    case 'version':
      if (ev.data.version) addFeed(ev, 'version', `⎘ version saved — ${ev.data.version.label}`);
      loadVersions();
      if (!$('tab-files').classList.contains('hidden')) loadFiles();
      break;
    case 'usage': {
      if (ev.data.turnCostUsd != null) {
        addFeed(ev, 'usage', `assistant turn · ${fmtCost(ev.data.turnCostUsd)} · project total ${fmtCost(ev.data.totalCostUsd)}`);
      }
      if (ev.data.byModel) {
        if (state.pipeline) state.pipeline.usage = { byModel: ev.data.byModel, totalCostUsd: ev.data.totalCostUsd, estimated: ev.data.estimated };
        renderUsage(state.pipeline?.usage ?? { byModel: ev.data.byModel, totalCostUsd: ev.data.totalCostUsd, estimated: ev.data.estimated });
        renderRun();
      }
      break;
    }
    case 'error':
      addFeed(ev, 'error', ev.data.message);
      break;
  }
}

/** Re-read the project record (output path, cover, usage) after something changed server-side. */
async function refreshDetail() {
  if (!state.current) return;
  const id = state.current.id;
  let detail;
  try { detail = await api(`/api/projects/${id}`); } catch { return; }
  if (state.current?.id !== id) return;
  state.current = { ...state.current, ...detail };
  renderStatus();
}

/** Re-read the whole run (after a revert, which changes many steps at once). */
async function reloadPipeline() {
  if (!state.current) return;
  const id = state.current.id;
  let pipeline;
  try { pipeline = await api(`/api/projects/${id}/pipeline`); } catch { return; }
  if (state.current?.id !== id) return;
  state.pipeline = pipeline;
  renderRun();
  renderMatrix();
}

/* ---------------- the run ---------------- */

function runStateText(run) {
  return {
    idle: 'Not started',
    running: 'Running',
    paused: 'Paused',
    awaiting_review: 'Waiting for your review',
    completed: 'Completed',
  }[run.state] ?? run.state;
}

function renderRun() {
  const p = state.pipeline;
  if (!p) return;
  const run = p.run;
  const prog = p.progress ?? { total: 0, done: 0, running: 0, failed: 0, etaMs: null };
  const st = $('run-state');
  st.textContent = runStateText(run);
  st.dataset.state = run.state;
  let reason = run.reason ?? '';
  if (run.state === 'paused' && run.resumeAt) {
    const mins = Math.max(0, Math.round((Date.parse(run.resumeAt) - Date.now()) / 60000));
    reason += ` — resumes ${mins ? `in ${mins} min` : 'shortly'}`;
  }
  $('run-reason').textContent = reason;
  const bits = [`${prog.done}/${prog.total} steps`];
  if (prog.running) bits.push(`${prog.running} in flight`);
  if (prog.failed) bits.push(`${prog.failed} failed`);
  if (run.state === 'running' && prog.etaMs != null) bits.push(`~${fmtDuration(prog.etaMs)} left`);
  if (run.startedAt) {
    const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
    bits.push(`${fmtDuration(end - Date.parse(run.startedAt))} elapsed`);
  }
  const cost = p.usage?.totalCostUsd ?? state.current?.usage?.totalCostUsd;
  if (cost != null) bits.push(`${p.usage?.estimated ? '~' : ''}${fmtCost(cost)}`);
  $('run-progress').textContent = bits.join(' · ');
  const total = Math.max(1, prog.total);
  $('run-bar-done').style.width = `${(prog.done / total) * 100}%`;
  $('run-bar-running').style.width = `${(prog.running / total) * 100}%`;
  $('run-bar-failed').style.width = `${(prog.failed / total) * 100}%`;

  // Controls.
  $('start-btn').classList.toggle('hidden', run.state !== 'idle');
  $('pause-btn').classList.toggle('hidden', run.state !== 'running');
  $('stop-btn').classList.toggle('hidden', run.state !== 'running');
  $('resume-btn').classList.toggle('hidden', run.state !== 'paused');
  const sel = $('concurrency');
  if (sel.options.length !== 8) {
    sel.innerHTML = '';
    for (let i = 1; i <= 8; i++) sel.add(new Option(String(i), String(i)));
  }
  sel.value = String(p.config?.concurrency ?? 3);
  renderGlobalSteps();
}

function cellIcon(step) {
  return { pending: '·', ready: '·', running: '◐', done: '●', failed: '✗', skipped: '–' }[step?.state ?? 'pending'];
}

function cellTitle(step) {
  if (!step) return 'pending';
  const bits = [`${STAGE_LABEL[step.stage] ?? step.stage}: ${step.state}`];
  if (step.rounds > 1) bits.push(`${step.rounds} rounds`);
  if (step.attempts > 1) bits.push(`${step.attempts} attempts`);
  if (step.durationMs) bits.push(fmtDuration(step.durationMs));
  if (step.costUsd) bits.push(fmtCost(step.costUsd));
  if (step.warning) bits.push(`⚠ ${step.warning}`);
  if (step.error) bits.push(`✗ ${step.error}`);
  return bits.join(' · ');
}

function renderGlobalSteps() {
  const p = state.pipeline;
  const wrap = $('global-steps');
  wrap.innerHTML = '';
  for (const [stage, name] of GLOBAL_STAGES) {
    const step = p.steps[stage];
    const el = document.createElement('button');
    el.className = `gstep state-${step?.state ?? 'pending'}`;
    el.dataset.step = stage;
    el.title = cellTitle(step);
    el.innerHTML = `<span class="g-icon"></span><span class="g-name"></span><span class="g-meta"></span>`;
    el.querySelector('.g-icon').textContent = cellIcon(step);
    el.querySelector('.g-name').textContent = name;
    el.querySelector('.g-meta').textContent = step?.state === 'done' ? fmtDuration(step.durationMs) : step?.state === 'running' ? 'running' : step?.state === 'failed' ? 'failed' : '';
    if (step?.warning) el.classList.add('has-warning');
    el.addEventListener('click', () => openStep(stage));
    wrap.appendChild(el);
  }
}

function renderMatrix() {
  const p = state.pipeline;
  if (!p) return;
  const thead = $('matrix').querySelector('thead');
  const tbody = $('matrix').querySelector('tbody');
  thead.innerHTML = `<tr><th class="m-chapter">Chapter</th>${STAGES.map(([, name]) => `<th>${name}</th>`).join('')}<th class="m-actions"></th></tr>`;
  tbody.innerHTML = '';
  const filter = $('feed-filter');
  const keep = filter.value;
  filter.innerHTML = '<option value="">everything</option><option value="engine">engine & assistant</option>';
  for (const c of p.chapters) {
    const tr = document.createElement('tr');
    tr.dataset.chapter = c.key;
    tr.className = c.excluded ? 'excluded' : '';
    const th = document.createElement('th');
    th.className = 'm-chapter';
    th.innerHTML = `<div class="m-title"></div><div class="m-sub"></div>`;
    th.querySelector('.m-title').textContent = c.title;
    th.querySelector('.m-title').title = c.path;
    th.querySelector('.m-sub').textContent = c.excluded
      ? `excluded${c.excludedReason ? ` · ${c.excludedReason}` : ''}`
      : `${c.words.toLocaleString()} words${c.note ? ' · note' : ''}`;
    if (c.note) th.querySelector('.m-sub').title = c.note;
    tr.appendChild(th);
    for (const [stage] of STAGES) {
      const td = document.createElement('td');
      td.dataset.step = `${c.key}/${stage}`;
      tr.appendChild(td);
      renderCellInto(td, p.steps[`${c.key}/${stage}`], c.excluded);
    }
    const actions = document.createElement('td');
    actions.className = 'm-actions';
    const menu = document.createElement('button');
    menu.className = 'ghost small';
    menu.textContent = '⋯';
    menu.title = 'Chapter actions';
    menu.setAttribute('aria-label', 'Chapter actions');
    menu.addEventListener('click', (e) => chapterMenu(e, c));
    actions.appendChild(menu);
    tr.appendChild(actions);
    tbody.appendChild(tr);
    if (!c.excluded) filter.add(new Option(c.title, c.key));
  }
  filter.value = [...filter.options].some((o) => o.value === keep) ? keep : '';
}

function renderCellInto(td, step, excluded) {
  td.className = `m-cell state-${excluded ? 'skipped' : (step?.state ?? 'pending')}`;
  td.title = excluded ? 'chapter excluded' : cellTitle(step);
  td.innerHTML = '';
  if (excluded) return;
  const btn = document.createElement('button');
  btn.className = 'cell';
  const icon = document.createElement('span');
  icon.className = 'c-icon';
  icon.textContent = cellIcon(step);
  btn.appendChild(icon);
  const meta = document.createElement('span');
  meta.className = 'c-meta';
  if (step?.state === 'done') meta.textContent = step.rounds > 1 ? `×${step.rounds}` : fmtDuration(step.durationMs);
  else if (step?.state === 'running') meta.textContent = step.rounds ? `r${step.rounds}` : '…';
  else if (step?.state === 'failed') meta.textContent = 'failed';
  btn.appendChild(meta);
  if (step?.warning) {
    const w = document.createElement('span');
    w.className = 'c-warn';
    w.textContent = '!';
    btn.appendChild(w);
  }
  btn.addEventListener('click', () => openStep(step?.id ?? td.dataset.step));
  td.appendChild(btn);
}

function renderCell(step) {
  if (!step.chapter) { renderGlobalSteps(); return; }
  const td = $('matrix').querySelector(`td[data-step="${CSS.escape(step.id)}"]`);
  if (!td) { renderMatrix(); return; }
  const c = state.pipeline.chapters.find((x) => x.key === step.chapter);
  renderCellInto(td, step, c?.excluded);
}

/* ---------------- chapter actions ---------------- */

function chapterMenu(e, c) {
  e.stopPropagation();
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu';
  const item = (text, fn) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', async () => {
      closeMenus();
      try { await fn(); } catch (err) { alert(err.message); }
    });
    menu.appendChild(b);
  };
  item(c.excluded ? 'Include in the translation' : 'Exclude from the translation', () => patch(projectApi(`/chapters/${encodeURIComponent(c.key)}`), { excluded: !c.excluded }));
  item(c.note ? 'Edit the note…' : 'Add a note…', async () => {
    const note = prompt(`A note for "${c.title}" — every later step about it sees this:`, c.note ?? '');
    if (note === null) return;
    await patch(projectApi(`/chapters/${encodeURIComponent(c.key)}`), { note });
  });
  if (!c.excluded) {
    for (const [stage, text] of RERUN_STAGES) {
      item(`Re-run: ${text}`, async () => {
        const note = prompt(`Re-run "${c.title}" — ${text}. Anything the agents should do differently?`, '');
        if (note === null) return;
        await post(projectApi('/chapters/rerun'), { chapters: [c.key], from: stage, note });
      });
    }
  }
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.right = `${document.documentElement.clientWidth - r.right - window.scrollX}px`;
  document.body.appendChild(menu);
}

function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) m.remove();
}
document.addEventListener('click', closeMenus);

/* ---------------- step modal ---------------- */

const stepModal = { id: null };

async function openStep(id) {
  stepModal.id = id;
  $('step-modal').classList.remove('hidden');
  $('step-log').innerHTML = '<span class="muted">Loading…</span>';
  let step;
  try {
    step = await api(projectApi(`/step?id=${encodeURIComponent(id)}`));
  } catch (e) {
    $('step-log').textContent = e.message;
    return;
  }
  renderStepModal(step);
  try {
    const events = await api(projectApi(`/events?step=${encodeURIComponent(id)}`));
    const log = $('step-log');
    log.innerHTML = '';
    if (!events.length) log.innerHTML = '<span class="muted">Nothing yet.</span>';
    for (const ev of events) {
      if (ev.type === 'tool_use') renderToolRow(log, ev, true);
      else if (ev.type === 'agent_text' || ev.type === 'thinking' || ev.type === 'error') renderFeedRow(log, ev, ev.type === 'agent_text' ? 'text' : ev.type, ev.type === 'error' ? ev.data.message : ev.data.text, { collapse: 400 });
    }
  } catch (e) {
    $('step-log').textContent = e.message;
  }
}

function closeStep() {
  stepModal.id = null;
  $('step-modal').classList.add('hidden');
}

function renderStepModal(step) {
  const c = step.chapter ? state.pipeline?.chapters.find((x) => x.key === step.chapter) : null;
  $('step-title').textContent = `${STAGE_LABEL[step.stage] ?? step.stage}${c ? ` — ${c.title}` : ''}`;
  const kv = $('step-kv');
  kv.innerHTML = '';
  const row = (k, v, cls) => {
    if (v == null || v === '') return;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
    kv.append(dt, dd);
  };
  row('State', step.state, step.state === 'done' ? 'ok' : step.state === 'failed' ? 'bad' : '');
  if (step.rounds) row('Rounds', String(step.rounds));
  if (step.durationMs) row('Took', fmtDuration(step.durationMs));
  if (step.costUsd) row('Cost', fmtCost(step.costUsd));
  row('Warning', step.warning, 'warn');
  row('Error', step.error, 'bad');
  const runs = $('step-runs');
  runs.innerHTML = '';
  if (!step.runs?.length) runs.innerHTML = '<li class="empty">No agent has run for this step yet.</li>';
  for (const r of [...(step.runs ?? [])].reverse()) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="li-main"><div class="li-title"></div><div class="li-sub"></div></div><div class="li-actions"></div>';
    li.querySelector('.li-title').textContent = `${r.agent} · ${r.mode}${r.round > 1 ? ` · round ${r.round}` : ''}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}`;
    const sub = [r.state, r.model ? r.model.replace(/^claude-/, '') : '', r.durationMs ? fmtDuration(r.durationMs) : '', r.costUsd ? fmtCost(r.costUsd) : '', r.tokens ? `${r.tokens.input.toLocaleString()} in / ${r.tokens.output.toLocaleString()} out` : '', r.error ?? ''].filter(Boolean);
    li.querySelector('.li-sub').textContent = sub.join(' · ');
    li.className = `run-${r.state}`;
    if (r.prompt) {
      const b = document.createElement('button');
      b.className = 'ghost small';
      b.textContent = 'prompt';
      b.addEventListener('click', () => {
        $('step-prompt').textContent = r.prompt;
        $('step-prompt-box').classList.remove('hidden');
        $('step-prompt-box').open = true;
      });
      li.querySelector('.li-actions').appendChild(b);
    }
    runs.appendChild(li);
  }
  $('step-prompt-box').classList.toggle('hidden', !step.runs?.some((r) => r.prompt));
  $('step-prompt').textContent = step.runs?.at(-1)?.prompt ?? '';
  const retry = $('step-retry');
  retry.classList.toggle('hidden', step.state === 'running');
  retry.textContent = step.state === 'failed' ? '↻ retry' : '↻ run again from here';
  retry.onclick = async () => {
    const q = step.chapter && step.stage !== 'summarize' && step.stage !== 'lexicon' && step.stage !== 'glossary'
      ? `Run "${STAGE_LABEL[step.stage]}" and every later stage of this chapter again?`
      : `Run "${STAGE_LABEL[step.stage]}" again?`;
    if (!confirm(q)) return;
    try { await post(projectApi('/steps/retry'), { id: step.id }); closeStep(); }
    catch (e) { alert(e.message); }
  };
}

$('step-close').addEventListener('click', closeStep);
$('step-modal').addEventListener('click', (e) => { if (e.target === $('step-modal')) closeStep(); });

/* ---------------- instructions ---------------- */

$('instructions-btn').addEventListener('click', () => {
  $('instructions-text').value = state.current?.context ?? '';
  $('instructions-modal').classList.remove('hidden');
  $('instructions-text').focus();
});
$('instructions-cancel').addEventListener('click', () => $('instructions-modal').classList.add('hidden'));
$('instructions-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await put(projectApi('/instructions'), { context: $('instructions-text').value });
    state.current.context = r.context;
    $('instructions-modal').classList.add('hidden');
  } catch (err) {
    alert(err.message);
  }
});

/* ---------------- review gate ---------------- */

function showReview(summary, warnings) {
  state.reviewPending = true;
  $('review-summary').textContent = summary ?? '';
  const ul = $('review-warnings');
  ul.innerHTML = '';
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    ul.appendChild(li);
  }
  $('review-instructions').value = '';
  $('review-scope').value = 'all';
  $('review-from').value = 'critique';
  const picks = $('review-chapters');
  picks.innerHTML = '';
  for (const c of state.pipeline?.chapters ?? []) {
    if (c.excluded) continue;
    const l = document.createElement('label');
    l.className = 'pick';
    l.innerHTML = '<input type="checkbox" /> <span></span>';
    l.querySelector('input').value = c.key;
    l.querySelector('span').textContent = c.title;
    picks.appendChild(l);
  }
  picks.classList.add('hidden');
  $('review-banner').classList.remove('hidden');
}

$('review-scope').addEventListener('change', (e) => $('review-chapters').classList.toggle('hidden', e.target.value !== 'some'));

$('review-approve').addEventListener('click', async () => {
  try { await post(projectApi('/review'), { decision: 'approve' }); }
  catch (e) { alert(e.message); }
});

$('review-revise').addEventListener('click', async () => {
  const instructions = $('review-instructions').value.trim();
  if (!instructions) { alert('Describe what you want changed in the box above.'); return; }
  const body = { decision: 'revise', instructions, from: $('review-from').value };
  if ($('review-scope').value === 'some') {
    body.chapters = [...$('review-chapters').querySelectorAll('input:checked')].map((i) => i.value);
    if (!body.chapters.length) { alert('Pick at least one chapter, or choose every chapter.'); return; }
  }
  try { await post(projectApi('/review'), body); }
  catch (e) { alert(e.message); }
});

/* ---------------- feed rendering ---------------- */

function agentClass(agent) {
  if (agent === 'engine') return 'engine';
  if (agent === 'assistant') return 'assistant';
  if (agent === 'user') return 'user';
  return 'subagent';
}

/** Whether an event is visible under the current chapter filter. */
function feedVisible(ev) {
  const f = state.feedFilter;
  if (!f) return true;
  if (f === 'engine') return !ev.chapter;
  return ev.chapter === f;
}

function renderFeedRow(container, ev, kind, text, opts = {}) {
  const el = document.createElement('div');
  el.className = `ev ${agentClass(ev.agent)} kind-${kind}`;
  if (ev.chapter) el.dataset.chapter = ev.chapter;
  if (ev.step) el.dataset.step = ev.step;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = ev.agent;
  badge.title = new Date(ev.ts).toLocaleTimeString();
  if (ev.chapter && container === $('feed')) {
    const c = state.pipeline?.chapters.find((x) => x.key === ev.chapter);
    badge.title += ` · ${c?.title ?? ev.chapter}`;
  }
  const body = document.createElement('div');
  body.className = 'body';
  if (opts.collapse && text.length > opts.collapse) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = text.slice(0, opts.collapse) + ' …';
    const rest = document.createElement('div');
    rest.textContent = text;
    details.append(summary, rest);
    body.appendChild(details);
  } else {
    body.textContent = text;
  }
  el.append(badge, body);
  if (container === $('feed')) {
    if (!feedVisible(ev)) el.style.display = 'none';
    insertFeed(container, el);
  } else {
    container.appendChild(el);
  }
  return el;
}

function addFeed(ev, kind, text, opts = {}) {
  renderFeedRow($('feed'), ev, kind, text ?? '', opts);
}

function renderToolRow(container, ev, forceVisible = false) {
  const el = document.createElement('div');
  el.className = `ev ${agentClass(ev.agent)} kind-tool tool-detail`;
  if (ev.chapter) el.dataset.chapter = ev.chapter;
  if (ev.step) el.dataset.step = ev.step;
  if (!forceVisible && (!$('show-detail').checked || !feedVisible(ev))) el.style.display = 'none';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = ev.agent;
  const body = document.createElement('div');
  body.className = 'body';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `⚙ ${ev.data.tool}`;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(ev.data.input, null, 2);
  details.append(summary, pre);
  body.appendChild(details);
  el.append(badge, body);
  if (container === $('feed')) insertFeed(container, el);
  else container.appendChild(el);
}

function addToolFeed(ev) {
  renderToolRow($('feed'), ev);
}

function insertFeed(feed, el) {
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.appendChild(el);
  while (feed.children.length > 1200) feed.removeChild(feed.firstChild);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function applyFeedFilter() {
  state.feedFilter = $('feed-filter').value;
  const detail = $('show-detail').checked;
  for (const el of $('feed').children) {
    const ev = { chapter: el.dataset.chapter };
    const visible = feedVisible(ev) && (detail || !el.classList.contains('tool-detail'));
    el.style.display = visible ? '' : 'none';
  }
  $('feed').scrollTop = $('feed').scrollHeight;
}
$('feed-filter').addEventListener('change', applyFeedFilter);
$('show-detail').addEventListener('change', applyFeedFilter);

/* ---------------- status & actions ---------------- */

function renderStatus() {
  const p = state.current;
  if (!p) return;
  const chip = $('project-status');
  chip.dataset.status = p.status;
  chip.textContent = label(p.status);
  $('download-btn').classList.toggle('hidden', !p.outputPath);
  $('repackage-btn').classList.toggle('hidden', !(p.outputPath && p.coverFilename));
}

/* ---------------- usage ---------------- */

function fmtTokens(n) {
  if (n == null) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function shortModel(model) {
  // claude-opus-4-6-20250514 -> opus 4.6 ; claude-sonnet-4-5 -> sonnet 4.5
  const m = model.match(/claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : model;
}

function renderUsage(usage) {
  const panel = $('usage-panel');
  const totalEl = $('usage-total');
  if (!usage || !usage.byModel || Object.keys(usage.byModel).length === 0) {
    panel.innerHTML = '<p class="muted usage-empty">No usage yet.</p>';
    totalEl.textContent = '';
    return;
  }
  const approx = usage.estimated ? '~' : '';
  totalEl.textContent = usage.totalCostUsd != null ? `${approx}$${usage.totalCostUsd.toFixed(2)}` : '';
  panel.innerHTML = '';
  const models = Object.entries(usage.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
  for (const [model, u] of models) {
    const el = document.createElement('div');
    el.className = 'usage-model';
    el.innerHTML = `
      <div class="um-name"><span></span><span class="um-cost">${approx}$${u.costUsd.toFixed(2)}</span></div>
      <div class="um-tokens">
        <span>in <b>${fmtTokens(u.inputTokens)}</b></span>
        <span>out <b>${fmtTokens(u.outputTokens)}</b></span>
        <span>cache r <b>${fmtTokens(u.cacheReadInputTokens)}</b></span>
        <span>cache w <b>${fmtTokens(u.cacheCreationInputTokens)}</b></span>
      </div>`;
    el.querySelector('.um-name span').textContent = shortModel(model);
    el.title = model;
    panel.appendChild(el);
  }
  const note = document.createElement('p');
  note.className = 'usage-note';
  note.textContent = usage.estimated
    ? '~ = live estimate from standard API pricing; replaced by the SDK’s exact figures at the next turn boundary.'
    : 'API-equivalent cost as reported by the SDK (an estimate when running on a subscription).';
  panel.appendChild(note);
}

/* ---------------- files & asset review ---------------- */

const asset = {
  path: null, // currently open file
  kind: null,
  reading: false, // reading view (rendered html) vs source
  excerpt: '',
};

function fmtSize(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kB';
  return n + ' B';
}

async function loadFiles() {
  if (!state.current) return;
  const tree = $('file-tree');
  let files;
  try {
    files = await api(`/api/projects/${state.current.id}/files`);
  } catch (e) {
    tree.innerHTML = '<p class="muted usage-empty">Could not load files.</p>';
    return;
  }
  if (!files.length) {
    tree.innerHTML = '<p class="muted usage-empty">No files yet.</p>';
    return;
  }
  // Group by top-level directory, in pipeline order.
  const groups = new Map();
  for (const f of files) {
    const slash = f.path.indexOf('/');
    const group = slash === -1 ? '(project root)' : f.path.slice(0, slash);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(f);
  }
  const ORDER = ['(project root)', 'original', 'notes', 'draft', 'critique', 'final'];
  const sorted = [...groups.entries()].sort(
    (a, b) =>
      (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99) ||
      a[0].localeCompare(b[0]),
  );
  tree.innerHTML = '';
  for (const [group, groupFiles] of sorted) {
    const details = document.createElement('details');
    details.open = group !== 'original' && group !== '(project root)';
    const summary = document.createElement('summary');
    summary.innerHTML = `${group} <span class="count">${groupFiles.length}</span>`;
    details.appendChild(summary);
    for (const f of groupFiles) {
      const row = document.createElement('div');
      row.className = 'file-row';
      const name = document.createElement('span');
      name.className = 'f-name';
      name.textContent = f.path.slice(group === '(project root)' ? 0 : group.length + 1);
      name.title = f.path;
      const size = document.createElement('span');
      size.className = 'f-size';
      size.textContent = fmtSize(f.size);
      row.append(name, size);
      row.addEventListener('click', () => openAsset(f.path, f.kind));
      details.appendChild(row);
    }
    tree.appendChild(details);
  }
}

async function openAsset(path, kind) {
  asset.path = path;
  asset.kind = kind;
  asset.excerpt = '';
  asset.reading = kind === 'text' && /\.x?html?$/i.test(path);
  $('asset-path').textContent = path;
  $('asset-quote').classList.add('hidden');
  $('asset-comment').value = '';
  $('asset-modal').classList.remove('hidden');
  await renderAsset();
}

async function renderAsset() {
  const container = $('asset-content');
  const toggle = $('asset-view-toggle');
  const isHtml = /\.x?html?$/i.test(asset.path ?? '');
  toggle.classList.toggle('hidden', !(asset.kind === 'text' && isHtml));
  toggle.textContent = asset.reading ? '</> source view' : '📖 reading view';
  container.classList.toggle('reading', asset.reading && isHtml);
  container.innerHTML = '<span class="muted">Loading…</span>';
  const projectId = state.current.id;
  try {
    if (asset.kind === 'image') {
      container.classList.remove('reading');
      container.innerHTML = '';
      const img = document.createElement('img');
      img.src = `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(asset.path)}&t=${Date.now()}`;
      container.appendChild(img);
      return;
    }
    if (asset.kind === 'binary') {
      container.classList.remove('reading');
      container.innerHTML = '';
      const a = document.createElement('a');
      a.href = `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(asset.path)}`;
      a.textContent = `⤓ download ${asset.path}`;
      a.style.color = 'var(--accent)';
      container.appendChild(a);
      return;
    }
    const data = await api(
      `/api/projects/${projectId}/files/content?path=${encodeURIComponent(asset.path)}`,
    );
    let text = data.content;
    if (/\.json$/i.test(asset.path)) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show raw */ }
    }
    if (asset.reading && isHtml) {
      container.innerHTML = '';
      const frame = document.createElement('iframe');
      // allow-same-origin (and no allow-scripts) so we can read text selections
      // for quoting while scripts inside the document stay disabled.
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.srcdoc = text;
      frame.addEventListener('load', () => {
        frame.contentDocument?.addEventListener('mouseup', () => {
          captureSelection(frame.contentDocument.getSelection());
        });
      });
      container.appendChild(frame);
    } else {
      container.textContent = text + (data.truncated ? '\n\n… (truncated)' : '');
    }
  } catch (e) {
    container.textContent = 'Could not load file: ' + e.message;
  }
}

function captureSelection(selection) {
  const text = (selection?.toString() ?? '').trim();
  if (!text) return;
  asset.excerpt = text.slice(0, 1500);
  $('asset-quote-text').textContent = asset.excerpt;
  $('asset-quote').classList.remove('hidden');
}

function closeAsset() {
  $('asset-modal').classList.add('hidden');
  asset.path = null;
}

$('asset-content').addEventListener('mouseup', () => captureSelection(window.getSelection()));
$('quote-clear').addEventListener('click', () => {
  asset.excerpt = '';
  $('asset-quote').classList.add('hidden');
});
$('asset-close').addEventListener('click', closeAsset);
$('asset-refresh').addEventListener('click', () => asset.path && renderAsset());
$('asset-view-toggle').addEventListener('click', () => {
  asset.reading = !asset.reading;
  renderAsset();
});
$('asset-modal').addEventListener('click', (e) => {
  if (e.target === $('asset-modal')) closeAsset();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && asset.path) closeAsset();
});

$('asset-comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const comment = $('asset-comment').value.trim();
  if (!comment || !asset.path || !state.current) return;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await post(`/api/projects/${state.current.id}/files/comment`, {
      path: asset.path,
      comment,
      excerpt: asset.excerpt || undefined,
    });
    $('asset-comment').value = '';
    asset.excerpt = '';
    $('asset-quote').classList.add('hidden');
    btn.textContent = 'Sent ✓';
    setTimeout(() => { btn.textContent = 'Send to assistant'; }, 1600);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* tab switching */
for (const tab of document.querySelectorAll('.tab-bar .tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab-bar .tab')) t.classList.toggle('active', t === tab);
    $('tab-versions').classList.toggle('hidden', tab.dataset.tab !== 'versions');
    $('tab-files').classList.toggle('hidden', tab.dataset.tab !== 'files');
    if (tab.dataset.tab === 'files') loadFiles();
  });
}
$('files-refresh').addEventListener('click', loadFiles);

/* ---------------- versions ---------------- */

async function loadVersions() {
  if (!state.current) return;
  let versions;
  try { versions = await api(`/api/projects/${state.current.id}/versions`); } catch { return; }
  renderVersions(versions);
}

function renderVersions(versions) {
  const list = $('version-list');
  list.innerHTML = '';
  for (const v of versions) {
    const li = document.createElement('li');
    li.className = 'version-item' + (v.auto ? ' auto' : '');
    const labelDiv = document.createElement('div');
    labelDiv.className = 'v-label';
    labelDiv.textContent = v.label;
    const meta = document.createElement('div');
    meta.className = 'v-meta';
    meta.innerHTML = `<span>${v.id.slice(0, 8)}</span><span>${new Date(v.date).toLocaleString()}</span>`;
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = 'revert';
    btn.addEventListener('click', async () => {
      if (!confirm(`Revert the workspace to "${v.label}"?\nThe current state is snapshotted first.`)) return;
      btn.disabled = true;
      try { await post(`/api/projects/${state.current.id}/versions/${v.id}/revert`); }
      catch (e) { alert(e.message); }
      btn.disabled = false;
      loadVersions();
      reloadPipeline();
    });
    meta.appendChild(btn);
    li.append(labelDiv, meta);
    list.appendChild(li);
  }
}

/* ---------------- wiring ---------------- */

$('new-project-btn').addEventListener('click', () => {
  $('new-project-form').classList.remove('hidden');
  $('new-project-btn').classList.add('hidden');
});
$('cancel-new-project').addEventListener('click', () => {
  $('new-project-form').classList.add('hidden');
  $('new-project-btn').classList.remove('hidden');
});

$('new-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = new FormData(form);
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const meta = await api('/api/projects', { method: 'POST', body: data });
    form.reset();
    form.classList.add('hidden');
    $('new-project-btn').classList.remove('hidden');
    await refreshProjects();
    await selectProject(meta.id);
  } catch (err) {
    alert('Could not create project: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

/** Run-control problems show on the run line itself; a modal alert would only get in the way. */
function runNotice(text) {
  const el = $('run-notice');
  el.textContent = text ?? '';
  el.classList.toggle('hidden', !text);
}

for (const [id, action] of [['start-btn', 'start'], ['pause-btn', 'pause'], ['resume-btn', 'resume'], ['stop-btn', 'stop']]) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    runNotice(null);
    try { await post(projectApi(`/run/${action}`)); }
    catch (e) { runNotice(e.message); }
    $(id).disabled = false;
  });
}

$('concurrency').addEventListener('change', async (e) => {
  try { await put(projectApi('/run/concurrency'), { concurrency: Number(e.target.value) }); }
  catch (err) { alert(err.message); }
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.current) return;
  input.value = '';
  try { await post(projectApi('/message'), { text }); }
  catch (err) { alert(err.message); }
});

$('download-btn').addEventListener('click', () => {
  window.location.href = projectApi('/download');
});

$('snapshot-btn').addEventListener('click', async () => {
  const labelText = prompt('Label for this snapshot:', 'manual snapshot');
  if (labelText == null) return;
  try { await post(projectApi('/versions'), { label: labelText }); }
  catch (e) { alert(e.message); }
  loadVersions();
});

$('cover-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !state.current) return;
  const data = new FormData();
  data.append('cover', file);
  try {
    const result = await api(projectApi('/cover'), { method: 'POST', body: data });
    state.current.coverFilename = result.coverFilename;
    renderStatus();
    if (state.current.outputPath) {
      if (confirm('Cover uploaded. Repackage the translated EPUB with it now?')) {
        await post(projectApi('/repackage'));
      }
    } else {
      alert('Cover uploaded — it will be used when the book is packaged.');
    }
  } catch (err) {
    alert(err.message);
  }
  e.target.value = '';
});

$('repackage-btn').addEventListener('click', async () => {
  $('repackage-btn').disabled = true;
  try { await post(projectApi('/repackage')); alert('Repackaged with the custom cover.'); }
  catch (e) { alert(e.message); }
  $('repackage-btn').disabled = false;
});

/* periodic light refresh: the run summary's clock, and project details that change server-side */
setInterval(async () => {
  if (!state.current || !state.signedIn) return;
  if (state.pipeline?.run.state === 'running' || state.pipeline?.run.state === 'paused') renderRun();
  try {
    const detail = await api(`/api/projects/${state.current.id}`);
    const changed = detail.status !== state.current.status
      || detail.coverFilename !== state.current.coverFilename
      || detail.outputPath !== state.current.outputPath;
    state.current = { ...state.current, ...detail };
    if (changed) renderStatus();
  } catch { /* server briefly unavailable */ }
}, 10000);

/* ---------------- sign-in: password first, then passkeys ---------------- */

const webauthn = window.SimpleWebAuthnBrowser;
const passkeysSupported = () => Boolean(webauthn?.browserSupportsWebAuthn?.() && window.isSecureContext);

function loginError(text) {
  const err = $('login-error');
  err.textContent = text ?? '';
  err.classList.toggle('hidden', !text);
}

async function showLogin(note) {
  state.signedIn = false;
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  for (const id of ['app', 'claude-modal', 'security-modal', 'passkey-setup', 'stepup-modal']) $(id).classList.add('hidden');
  $('login-screen').classList.remove('hidden');
  loginError(null);
  let st = { passkeys: false, passwordSet: true };
  try { st = await (await fetch('/api/auth/state')).json(); } catch { /* offline: show the password form */ }
  // Passkey first when there is one; the password is always there as the backup.
  const passkeyFirst = st.passkeys && passkeysSupported();
  $('passkey-signin').classList.toggle('hidden', !passkeyFirst);
  $('login-or').classList.toggle('hidden', !passkeyFirst || !st.passwordSet);
  $('login-form').classList.toggle('hidden', !st.passwordSet);
  $('password-signin').classList.toggle('primary', !passkeyFirst);
  let text = note ?? (passkeyFirst ? 'Sign in with your passkey.' : 'Enter the password to open the studio.');
  if (!st.passwordSet && !passkeyFirst) text = 'LEXIS_PASSWORD is not set on the server, so nobody can sign in yet.';
  $('login-note').textContent = text;
  if (passkeyFirst) $('passkey-signin').focus();
  else $('login-password').focus();
}

async function enterApp() {
  state.signedIn = true;
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  await Promise.all([refreshProjects(), loadClaude(), loadSecurity()]);
  if (state.current) selectProject(state.current.id).catch(() => undefined);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError(null);
  try {
    const r = await post('/api/auth/password', { password: $('login-password').value });
    $('login-password').value = '';
    await enterApp();
    if (!r.passkeys && !sessionStorageGet('lexis.passkeyLater')) openPasskeySetup();
  } catch (ex) {
    loginError(ex.message);
  }
});

$('passkey-signin').addEventListener('click', async () => {
  loginError(null);
  const btn = $('passkey-signin');
  btn.disabled = true;
  try {
    const { challengeId, options } = await post('/api/auth/passkey/options');
    const response = await webauthn.startAuthentication({ optionsJSON: options });
    await post('/api/auth/passkey/verify', { challengeId, response });
    await enterApp();
  } catch (ex) {
    loginError(passkeyErrorText(ex));
  } finally {
    btn.disabled = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  await post('/api/auth/logout').catch(() => undefined);
  showLogin('Signed out.');
});

function passkeyErrorText(ex) {
  if (ex?.name === 'NotAllowedError' || ex?.code === 'ERROR_CEREMONY_ABORTED') return 'Passkey request cancelled.';
  if (ex?.name === 'InvalidStateError' || ex?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'That passkey is already registered here.';
  return ex?.message ?? String(ex);
}

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

/* Step-up: before adding or removing a passkey the server wants recent proof it's you. */
async function withStepUp(fn) {
  try {
    return await fn();
  } catch (ex) {
    if (ex.status !== 403 || !ex.body?.stepUp) throw ex;
    let confirmed = false;
    if (ex.body.stepUp === 'passkey' && passkeysSupported()) {
      try {
        const { challengeId, options } = await post('/api/auth/stepup/passkey/options');
        const response = await webauthn.startAuthentication({ optionsJSON: options });
        await post('/api/auth/stepup/passkey/verify', { challengeId, response });
        confirmed = true;
      } catch {
        // No passkey at hand (or cancelled): the password is the backup.
      }
    }
    if (!confirmed) await stepUpPassword();
    return fn();
  }
}

function stepUpPassword() {
  return new Promise((resolve, reject) => {
    const modal = $('stepup-modal');
    const form = $('stepup-form');
    const err = $('stepup-error');
    err.classList.add('hidden');
    $('stepup-password').value = '';
    modal.classList.remove('hidden');
    $('stepup-password').focus();
    const done = (ok, value) => {
      modal.classList.add('hidden');
      form.removeEventListener('submit', submit);
      $('stepup-cancel').removeEventListener('click', cancel);
      ok ? resolve(value) : reject(new Error('Cancelled.'));
    };
    const submit = async (e) => {
      e.preventDefault();
      try {
        await post('/api/auth/stepup/password', { password: $('stepup-password').value });
        done(true);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    };
    const cancel = () => done(false);
    form.addEventListener('submit', submit);
    $('stepup-cancel').addEventListener('click', cancel);
  });
}

async function registerPasskey(name) {
  return withStepUp(async () => {
    const { challengeId, options } = await post('/api/auth/passkeys/options');
    const response = await webauthn.startRegistration({ optionsJSON: options });
    return post('/api/auth/passkeys/verify', { challengeId, response, name });
  });
}

/* ---------------- passkey setup prompt ---------------- */

function openPasskeySetup() {
  const msg = $('passkey-setup-msg');
  msg.className = 'small hidden';
  $('passkey-setup-name').value = '';
  $('passkey-setup').classList.remove('hidden');
  if (!passkeysSupported()) {
    msg.textContent = window.isSecureContext ? 'This browser cannot create passkeys.' : 'Passkeys need https (or localhost).';
    msg.className = 'small bad';
    $('passkey-setup-create').disabled = true;
  } else {
    $('passkey-setup-create').disabled = false;
  }
}

$('passkey-setup-later').addEventListener('click', () => {
  sessionStorageSet('lexis.passkeyLater', '1');
  $('passkey-setup').classList.add('hidden');
});

$('passkey-setup-create').addEventListener('click', async () => {
  const msg = $('passkey-setup-msg');
  const btn = $('passkey-setup-create');
  btn.disabled = true;
  msg.className = 'small';
  msg.textContent = 'Follow your browser’s prompt…';
  try {
    await registerPasskey($('passkey-setup-name').value);
    $('passkey-setup').classList.add('hidden');
    await loadSecurity();
    openSecurity('Passkey created. Sign in with it from now on; the password stays as a backup.');
  } catch (ex) {
    msg.textContent = passkeyErrorText(ex);
    msg.className = 'small bad';
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- security panel ---------------- */

const security = { data: null };

function securityMsg(text, ok) {
  const el = $('security-msg');
  el.textContent = text ?? '';
  el.className = 'small' + (text ? (ok ? ' ok' : ' bad') : ' hidden');
}

function fmtWhen(iso) {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function shortAgent(ua) {
  if (!ua) return 'unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

async function loadSecurity() {
  try {
    security.data = await api('/api/auth/security');
  } catch {
    return;
  }
  renderSecurity();
}

function renderSecurity() {
  const d = security.data;
  if (!d) return;
  const hasPasskey = d.passkeys.length > 0;
  $('security-dot').className = 'dot ' + (hasPasskey ? 'ok' : 'bad');
  $('security-open').title = hasPasskey ? 'Passkeys and signed-in browsers' : 'No passkey yet: set one up';
  $('security-summary').textContent = hasPasskey
    ? 'Sign in with a passkey; the password still works as a backup, so keep it long and private.'
    : 'No passkey yet: only the password protects lexis. Add a passkey for quick, phishing-proof sign-in.';

  const pl = $('passkey-list');
  pl.innerHTML = '';
  if (!hasPasskey) pl.innerHTML = '<li class="empty">None yet.</li>';
  for (const p of d.passkeys) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="li-main"><div class="li-title"></div><div class="li-sub"></div></div><div class="li-actions"></div>';
    li.querySelector('.li-title').textContent = p.name;
    li.querySelector('.li-sub').textContent =
      `${p.deviceType === 'multiDevice' ? 'synced' : 'this device only'} · added ${fmtWhen(p.createdAt)} · last used ${fmtWhen(p.lastUsedAt)}`;
    const rename = document.createElement('button');
    rename.className = 'ghost small';
    rename.textContent = 'rename';
    rename.addEventListener('click', async () => {
      const name = prompt('New name for this passkey:', p.name);
      if (!name) return;
      try { await post(`/api/auth/passkeys/${encodeURIComponent(p.id)}/rename`, { name }); await loadSecurity(); }
      catch (ex) { securityMsg(ex.message, false); }
    });
    const remove = document.createElement('button');
    remove.className = 'ghost small danger';
    remove.textContent = 'remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove "${p.name}"? It will no longer sign in.`)) return;
      try {
        await withStepUp(() => del(`/api/auth/passkeys/${encodeURIComponent(p.id)}`));
        securityMsg(`Removed "${p.name}".`, true);
        await loadSecurity();
      } catch (ex) { securityMsg(passkeyErrorText(ex), false); }
    });
    li.querySelector('.li-actions').append(rename, remove);
    pl.appendChild(li);
  }

  const sl = $('session-list');
  sl.innerHTML = '';
  for (const s of d.sessions) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="li-main"><div class="li-title"></div><div class="li-sub"></div></div><div class="li-actions"></div>';
    li.querySelector('.li-title').textContent = shortAgent(s.userAgent);
    if (s.current) li.querySelector('.li-title').insertAdjacentHTML('beforeend', '<span class="tag">this browser</span>');
    li.querySelector('.li-sub').textContent =
      `${s.method} · signed in ${fmtWhen(s.createdAt)} · last seen ${fmtWhen(s.lastSeenAt)}${s.ip ? ' · ' + s.ip : ''}`;
    const out = document.createElement('button');
    out.className = 'ghost small';
    out.textContent = 'sign out';
    out.addEventListener('click', async () => {
      try {
        await del(`/api/auth/sessions/${encodeURIComponent(s.id)}`);
        if (s.current) { showLogin('Signed out.'); return; }
        await loadSecurity();
      } catch (ex) { securityMsg(ex.message, false); }
    });
    li.querySelector('.li-actions').append(out);
    sl.appendChild(li);
  }
  $('sessions-revoke-others').disabled = d.sessions.length < 2;
}

function openSecurity(message) {
  $('security-modal').classList.remove('hidden');
  securityMsg(message ?? null, true);
  loadSecurity();
}

$('security-open').addEventListener('click', () => {
  if (security.data && !security.data.passkeys.length) openPasskeySetup();
  else openSecurity();
});
$('security-close').addEventListener('click', () => $('security-modal').classList.add('hidden'));

$('passkey-add').addEventListener('click', async () => {
  if (!passkeysSupported()) { securityMsg('Passkeys need https (or localhost) and a supporting browser.', false); return; }
  const name = prompt('Name this passkey (e.g. iPhone, YubiKey):', '');
  if (name === null) return;
  securityMsg('Follow your browser’s prompt…', true);
  try {
    const r = await registerPasskey(name);
    securityMsg(`Added "${r.passkey.name}".`, true);
    await loadSecurity();
  } catch (ex) {
    securityMsg(passkeyErrorText(ex), false);
  }
});

$('sessions-revoke-others').addEventListener('click', async () => {
  if (!confirm('Sign out every other browser?')) return;
  try {
    const r = await post('/api/auth/sessions/revoke-others');
    securityMsg(`Signed out ${r.signedOut} browser(s).`, true);
    await loadSecurity();
  } catch (ex) { securityMsg(ex.message, false); }
});

/* ---------------- Claude link ---------------- */

const claude = { status: null, account: undefined, pending: null };

function claudeMsg(text, ok) {
  const el = $('claude-msg');
  el.textContent = text ?? '';
  el.className = 'small' + (text ? (ok ? ' ok' : ' bad') : ' hidden');
}

async function loadClaude(withAccount = false) {
  try {
    const s = await api('/api/claude' + (withAccount ? '?account=1' : ''));
    claude.status = s;
    claude.pending = claude.pending ?? s.inProgress;
    if (withAccount) claude.account = s.account ?? null;
    renderClaude();
  } catch (e) {
    claudeMsg(e.message, false);
  }
}

function renderClaude() {
  const s = claude.status;
  if (!s) return;
  const linked = s.auth === 'ok';
  $('claude-dot').className = 'dot ' + (linked ? 'ok' : s.auth === 'unknown' ? 'warn' : 'bad');
  $('claude-label').textContent = linked
    ? `Claude linked${claude.account?.email ? ' · ' + claude.account.email : ''}`
    : s.auth === 'unknown' ? 'Claude: status unknown' : 'Claude not linked — sign in';
  $('tier-note').textContent =
    `${s.models.translation} does the translating. ${s.models.mechanical} does everything else.`;

  const kv = $('claude-kv');
  kv.innerHTML = '';
  const row = (k, v, cls) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
    kv.append(dt, dd);
  };
  row('Status', linked ? 'linked' : s.auth === 'unknown' ? 'unknown' : 'not linked', linked ? 'ok' : 'bad');
  row('Credential', s.credentialLabel);
  if (claude.account?.email) {
    row('Account', claude.account.email + (claude.account.subscriptionType ? ` · ${claude.account.subscriptionType}` : ''));
  }
  row('Translation', `${s.models.translation} · effort ${s.effort.translation}`);
  row('Mechanical', `${s.models.mechanical} · effort ${s.effort.mechanical}`);
  row('Assistant', `${s.models.assistant} · effort ${s.effort.assistant}`);

  const canWeb = !s.shadowedByEnv;
  $('claude-shadowed').classList.toggle('hidden', canWeb);
  $('claude-steps').classList.toggle('hidden', !claude.pending);
  $('claude-actions').classList.toggle('hidden', Boolean(claude.pending));
  if (claude.pending) $('claude-link').href = claude.pending.url;
  $('claude-signin').classList.toggle('hidden', !canWeb);
  $('claude-signin').textContent = s.hasLoginFile ? 'Sign in again' : 'Sign in with Claude';
  $('claude-signout').classList.toggle('hidden', !(canWeb && s.hasLoginFile));
}

$('claude-open').addEventListener('click', () => {
  $('claude-modal').classList.remove('hidden');
  claudeMsg(null);
  loadClaude(true);
});
$('claude-close').addEventListener('click', () => $('claude-modal').classList.add('hidden'));

$('claude-signin').addEventListener('click', async () => {
  const btn = $('claude-signin');
  btn.disabled = true;
  claudeMsg('Asking Claude Code for a sign-in link…', true);
  try {
    claude.pending = await post('/api/claude/login/start');
    $('claude-code').value = '';
    claudeMsg(null);
    renderClaude();
  } catch (e) {
    claudeMsg(e.message, false);
  } finally {
    btn.disabled = false;
  }
});

$('claude-steps').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!claude.pending) return;
  const code = $('claude-code').value.trim();
  if (!code) return;
  const btn = $('claude-submit');
  btn.disabled = true;
  claudeMsg('Linking…', true);
  try {
    const r = await post('/api/claude/login/code', { id: claude.pending.id, code });
    claude.pending = null;
    if (r.ok) {
      claude.account = r.account ?? null;
      claudeMsg(`Linked${r.account?.email ? ' as ' + r.account.email : ''}.`, true);
    } else {
      claudeMsg(r.error ?? 'Sign-in failed. Start again.', false);
    }
    await loadClaude();
  } catch (ex) {
    claudeMsg(ex.message, false);
  } finally {
    btn.disabled = false;
  }
});

$('claude-cancel').addEventListener('click', async () => {
  claude.pending = null;
  renderClaude();
  await post('/api/claude/login/cancel').catch(() => undefined);
});

$('claude-signout').addEventListener('click', async () => {
  if (!confirm('Sign this server out of Claude? Translations cannot run until you sign in again.')) return;
  try {
    await post('/api/claude/logout');
    claude.account = null;
    claudeMsg('Signed out of Claude.', true);
    await loadClaude();
  } catch (e) {
    claudeMsg(e.message, false);
  }
});

/* ---------------- boot ---------------- */

(async () => {
  try {
    const s = await (await fetch('/api/auth/state')).json();
    if (s.signedIn) await enterApp();
    else await showLogin();
  } catch {
    await showLogin();
  }
})();
