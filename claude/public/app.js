/* lexis studio frontend — no build step, no dependencies */
'use strict';

const $ = (id) => document.getElementById(id);

const PHASES = [
  ['preparation', 'Prepare'],
  ['initialization', 'Initialize'],
  ['extraction', 'Extract'],
  ['production', 'Translate'],
  ['review', 'Review'],
  ['packaging', 'Package'],
  ['done', 'Done'],
];

const state = {
  projects: [],
  current: null, // ProjectMeta
  ws: null,
  lastSeq: 0,
  phaseState: new Map(), // phase -> started|completed|failed
  chapterState: new Map(), // phase -> Map(chapter -> state)
  activeTasks: new Set(), // subagent names currently running
  reviewPending: false,
};

/* ---------------- api helpers ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error ?? detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

/* ---------------- project list ---------------- */

async function refreshProjects() {
  state.projects = await api('/api/projects');
  const list = $('project-list');
  list.innerHTML = '';
  for (const p of state.projects) {
    const el = document.createElement('div');
    el.className = 'project-item' + (state.current?.id === p.id ? ' active' : '');
    el.innerHTML = `
      <div class="p-name"></div>
      <div class="p-sub"><span class="chip status" data-status="${p.status}">${label(p.status)}</span><span>${p.targetLanguage}</span></div>`;
    el.querySelector('.p-name').textContent = p.name;
    el.addEventListener('click', () => selectProject(p.id));
    list.appendChild(el);
  }
}

function label(status) {
  return {
    created: 'new',
    running: 'running',
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
  state.phaseState = new Map();
  state.chapterState = new Map();
  state.activeTasks = new Set();
  state.reviewPending = false;

  $('empty-state').classList.add('hidden');
  $('project-view').classList.remove('hidden');
  $('project-title').textContent = detail.name;
  $('project-lang').textContent = detail.targetLanguage;
  $('feed').innerHTML = '';
  $('review-banner').classList.add('hidden');

  renderStatus();
  renderVersions(detail.versions ?? []);
  renderUsage(detail.usage);
  renderBoard();
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
  ws.onclose = () => {
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
      if (ev.data.status !== 'awaiting_review') {
        state.reviewPending = false;
        $('review-banner').classList.add('hidden');
      }
      renderStatus();
      refreshProjects();
      if (ev.data.detail) addFeed(ev, 'progress', ev.data.detail);
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
    case 'task_start':
      state.activeTasks.add(ev.data.agent);
      addFeed(ev, 'task', `⇢ ${ev.data.agent} — ${ev.data.description || 'started'}`);
      renderSpinner();
      break;
    case 'task_end':
      state.activeTasks.delete(ev.data.agent);
      addFeed(ev, 'task', `⇠ ${ev.data.agent} finished`);
      renderSpinner();
      break;
    case 'progress':
      applyProgress(ev.data);
      addFeed(ev, 'progress', progressText(ev.data));
      break;
    case 'review_request':
      state.reviewPending = true;
      $('review-summary').textContent = ev.data.summary ?? '';
      $('review-instructions').value = '';
      $('review-banner').classList.remove('hidden');
      addFeed(ev, 'task', '⏸ review requested — see banner above');
      break;
    case 'review_response':
      addFeed(ev, 'text', ev.data.decision === 'approve'
        ? '✓ Approved — packaging.'
        : `↺ Another pass requested: ${ev.data.instructions ?? ''}`);
      break;
    case 'user_message':
      addFeed(ev, 'text', ev.data.text);
      break;
    case 'version':
      if (ev.data.version) addFeed(ev, 'version', `⎘ version saved — ${ev.data.version.label}`);
      loadVersions();
      break;
    case 'usage': {
      const turn = ev.data.turnCostUsd ?? ev.data.costUsd;
      const total = ev.data.totalCostUsd;
      if (turn != null) {
        const totalPart = total != null ? ` · project total $${Number(total).toFixed(2)}` : '';
        addFeed(ev, 'usage', `turn · $${Number(turn).toFixed(2)}${totalPart} · ${Math.round(ev.data.durationMs / 1000)}s`);
      }
      if (ev.data.byModel) renderUsage({ byModel: ev.data.byModel, totalCostUsd: total });
      break;
    }
    case 'error':
      addFeed(ev, 'error', ev.data.message);
      break;
  }
}

function progressText(d) {
  const chapter = d.chapter ? ` · ${d.chapter}` : '';
  const icon = { started: '◐', completed: '●', failed: '✗' }[d.state] ?? '·';
  return `${icon} ${d.phase}${chapter} ${d.state}${d.detail ? ' — ' + d.detail : ''}`;
}

function applyProgress(d) {
  if (d.chapter) {
    if (!state.chapterState.has(d.phase)) state.chapterState.set(d.phase, new Map());
    state.chapterState.get(d.phase).set(d.chapter, d.state);
    if (!state.phaseState.get(d.phase) || state.phaseState.get(d.phase) === 'completed') {
      state.phaseState.set(d.phase, 'started');
    }
  } else {
    state.phaseState.set(d.phase, d.state);
  }
  renderBoard();
}

/* ---------------- feed rendering ---------------- */

function agentClass(agent) {
  if (agent === 'orchestrator') return 'orchestrator';
  if (agent === 'user') return 'user';
  return 'subagent';
}

function addFeed(ev, kind, text, opts = {}) {
  const feed = $('feed');
  const el = document.createElement('div');
  el.className = `ev ${agentClass(ev.agent)} kind-${kind}`;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = ev.agent;
  badge.title = new Date(ev.ts).toLocaleTimeString();
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
  insertFeed(feed, el);
}

function addToolFeed(ev) {
  const feed = $('feed');
  const el = document.createElement('div');
  el.className = `ev ${agentClass(ev.agent)} kind-tool tool-detail`;
  el.style.display = $('show-detail').checked ? '' : 'none';
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
  insertFeed(feed, el);
}

function insertFeed(feed, el) {
  const spinner = feed.querySelector('.spinner-row');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  if (spinner) feed.insertBefore(el, spinner);
  else feed.appendChild(el);
  while (feed.children.length > 800) feed.removeChild(feed.firstChild);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function renderSpinner() {
  const feed = $('feed');
  let spinner = feed.querySelector('.spinner-row');
  if (state.activeTasks.size === 0) {
    spinner?.remove();
    return;
  }
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.className = 'spinner-row';
    spinner.innerHTML = '<span class="spinner"></span><span class="spinner-text"></span>';
    feed.appendChild(spinner);
  }
  spinner.querySelector('.spinner-text').textContent = [...state.activeTasks].join(', ') + ' working…';
  feed.scrollTop = feed.scrollHeight;
}

/* ---------------- pipeline board ---------------- */

function renderBoard() {
  const board = $('pipeline-board');
  board.innerHTML = '';
  for (const [phase, name] of PHASES) {
    const st = state.phaseState.get(phase);
    const el = document.createElement('div');
    el.className = 'phase' + (st ? ` state-${st}` : '');
    const stateText = { started: 'in progress', completed: 'complete', failed: 'failed' }[st] ?? '—';
    el.innerHTML = `<div class="ph-name">${name}</div><div class="ph-state">${stateText}</div>`;
    const chapters = state.chapterState.get(phase);
    if (chapters?.size) {
      const wrap = document.createElement('div');
      wrap.className = 'chapter-chips';
      for (const [chapter, cst] of chapters) {
        const chip = document.createElement('span');
        chip.className = `chapter-chip state-${cst}`;
        chip.textContent = chapter.replace(/\.x?html?$/i, '');
        chip.title = `${chapter}: ${cst}`;
        wrap.appendChild(chip);
      }
      el.appendChild(wrap);
    }
    board.appendChild(el);
  }
}

/* ---------------- status & actions ---------------- */

function renderStatus() {
  const p = state.current;
  if (!p) return;
  const chip = $('project-status');
  chip.dataset.status = p.status;
  chip.textContent = label(p.status);
  $('start-btn').classList.toggle('hidden', p.status !== 'created');
  $('download-btn').classList.toggle('hidden', p.status !== 'completed');
  $('interrupt-btn').classList.toggle('hidden', p.status !== 'running' && p.status !== 'awaiting_review');
  $('repackage-btn').classList.toggle('hidden', !(p.status === 'completed' && p.coverFilename));
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
  totalEl.textContent = usage.totalCostUsd != null ? `$${usage.totalCostUsd.toFixed(2)}` : '';
  panel.innerHTML = '';
  const models = Object.entries(usage.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
  for (const [model, u] of models) {
    const el = document.createElement('div');
    el.className = 'usage-model';
    el.innerHTML = `
      <div class="um-name"><span></span><span class="um-cost">$${u.costUsd.toFixed(2)}</span></div>
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
  note.textContent = 'API-equivalent cost as reported by the SDK (an estimate when running on a subscription).';
  panel.appendChild(note);
}

/* ---------------- versions ---------------- */

async function loadVersions() {
  if (!state.current) return;
  renderVersions(await api(`/api/projects/${state.current.id}/versions`));
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

$('start-btn').addEventListener('click', async () => {
  $('start-btn').disabled = true;
  try { await post(`/api/projects/${state.current.id}/start`); }
  catch (e) { alert(e.message); }
  $('start-btn').disabled = false;
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.current) return;
  input.value = '';
  try { await post(`/api/projects/${state.current.id}/message`, { text }); }
  catch (err) { alert(err.message); }
});

$('review-approve').addEventListener('click', async () => {
  try { await post(`/api/projects/${state.current.id}/review`, { decision: 'approve' }); }
  catch (e) { alert(e.message); }
});

$('review-revise').addEventListener('click', async () => {
  const instructions = $('review-instructions').value.trim();
  if (!instructions) { alert('Describe what you want changed in the box above.'); return; }
  try { await post(`/api/projects/${state.current.id}/review`, { decision: 'revise', instructions }); }
  catch (e) { alert(e.message); }
});

$('interrupt-btn').addEventListener('click', async () => {
  try { await post(`/api/projects/${state.current.id}/interrupt`); }
  catch (e) { alert(e.message); }
});

$('download-btn').addEventListener('click', () => {
  window.location.href = `/api/projects/${state.current.id}/download`;
});

$('snapshot-btn').addEventListener('click', async () => {
  const labelText = prompt('Label for this snapshot:', 'manual snapshot');
  if (labelText == null) return;
  try { await post(`/api/projects/${state.current.id}/versions`, { label: labelText }); }
  catch (e) { alert(e.message); }
  loadVersions();
});

$('cover-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !state.current) return;
  const data = new FormData();
  data.append('cover', file);
  try {
    const result = await api(`/api/projects/${state.current.id}/cover`, { method: 'POST', body: data });
    state.current.coverFilename = result.coverFilename;
    renderStatus();
    if (state.current.status === 'completed') {
      if (confirm('Cover uploaded. Repackage the translated EPUB with it now?')) {
        await post(`/api/projects/${state.current.id}/repackage`);
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
  try { await post(`/api/projects/${state.current.id}/repackage`); alert('Repackaged with the custom cover.'); }
  catch (e) { alert(e.message); }
  $('repackage-btn').disabled = false;
});

$('show-detail').addEventListener('change', (e) => {
  for (const el of document.querySelectorAll('.tool-detail')) {
    el.style.display = e.target.checked ? '' : 'none';
  }
});

/* periodic light refresh of project detail (status can change server-side) */
setInterval(async () => {
  if (!state.current) return;
  try {
    const detail = await api(`/api/projects/${state.current.id}`);
    const changed = detail.status !== state.current.status
      || detail.coverFilename !== state.current.coverFilename
      || detail.outputPath !== state.current.outputPath;
    state.current = { ...state.current, ...detail };
    if (changed) renderStatus();
  } catch { /* server briefly unavailable */ }
}, 10000);

refreshProjects();
