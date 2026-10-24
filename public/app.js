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
  expandedPhases: new Set(), // phases whose chapter chips are expanded
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

const del = (path) => api(path, { method: 'DELETE' });

const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

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
  state.expandedPhases = new Set();

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
  closeAsset();
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
      // The workspace changed; keep the asset browser fresh if it's showing.
      if (!$('tab-files').classList.contains('hidden')) loadFiles();
      break;
    case 'usage': {
      const turn = ev.data.turnCostUsd ?? ev.data.costUsd;
      const total = ev.data.totalCostUsd;
      if (turn != null) {
        const totalPart = total != null ? ` · project total $${Number(total).toFixed(2)}` : '';
        addFeed(ev, 'usage', `turn · $${Number(turn).toFixed(2)}${totalPart} · ${Math.round(ev.data.durationMs / 1000)}s`);
      }
      if (ev.data.byModel) {
        renderUsage({ byModel: ev.data.byModel, totalCostUsd: total, estimated: ev.data.estimated });
      }
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

function shortChapter(chapter) {
  return chapter
    .replace(/\.x?html?$/i, '')
    .replace(/^index_split_0*/i, '§')
    .replace(/^\d{8,}[_-]/, ''); // drop redundant ISBN/book-id prefix (e.g. 9780062077868_Chapter_1)
}

function renderBoard() {
  const board = $('pipeline-board');
  board.innerHTML = '';
  for (const [phase, name] of PHASES) {
    const st = state.phaseState.get(phase);
    const el = document.createElement('div');
    el.className = 'phase' + (st ? ` state-${st}` : '');
    el.innerHTML = `<div class="ph-name">${name}</div>`;
    const chapters = state.chapterState.get(phase);

    if (!chapters?.size) {
      const stateText = { started: 'in progress', completed: 'complete', failed: 'failed' }[st] ?? '—';
      el.insertAdjacentHTML('beforeend', `<div class="ph-state">${stateText}</div>`);
      board.appendChild(el);
      continue;
    }

    // Chapter-scoped phase: compact summary + progress bar, expandable chips.
    const counts = { completed: 0, started: 0, failed: 0 };
    for (const s of chapters.values()) if (s in counts) counts[s]++;
    const total = chapters.size;

    const stateLine = document.createElement('div');
    stateLine.className = 'ph-state';
    const bits = [`${counts.completed}/${total} done`];
    if (counts.started) bits.push(`${counts.started} running`);
    if (counts.failed) bits.push(`${counts.failed} failed`);
    stateLine.textContent = bits.join(' · ');
    el.appendChild(stateLine);

    const bar = document.createElement('div');
    bar.className = 'ph-bar';
    bar.innerHTML =
      `<span class="seg-completed" style="width:${(counts.completed / total) * 100}%"></span>` +
      `<span class="seg-started" style="width:${(counts.started / total) * 100}%"></span>` +
      `<span class="seg-failed" style="width:${(counts.failed / total) * 100}%"></span>`;
    el.appendChild(bar);

    const expanded = state.expandedPhases.has(phase);

    // When collapsed, still surface what's being worked on right now.
    const running = [...chapters].filter(([, s]) => s === 'started').map(([c]) => c);
    if (running.length && !expanded) {
      const hint = document.createElement('div');
      hint.className = 'ph-running';
      hint.textContent = '◐ ' + running.map(shortChapter).join(', ');
      hint.title = running.join(', ');
      el.appendChild(hint);
    }

    if (expanded) {
      const wrap = document.createElement('div');
      wrap.className = 'chapter-chips';
      for (const [chapter, cst] of chapters) {
        const chip = document.createElement('span');
        chip.className = `chapter-chip state-${cst}`;
        chip.textContent = shortChapter(chapter);
        chip.title = `${chapter}: ${cst}`;
        wrap.appendChild(chip);
      }
      el.appendChild(wrap);
    }

    const toggle = document.createElement('button');
    toggle.className = 'ph-toggle';
    toggle.textContent = expanded ? '▴ collapse' : `▾ ${total} chapters`;
    toggle.addEventListener('click', () => {
      if (expanded) state.expandedPhases.delete(phase);
      else state.expandedPhases.add(phase);
      renderBoard();
    });
    el.appendChild(toggle);
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
    setTimeout(() => { btn.textContent = 'Send to orchestrator'; }, 1600);
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
  if (!state.current || !state.signedIn) return;
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
  row('Orchestrator', `${s.models.orchestrator} · effort ${s.effort.orchestrator}`);

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
