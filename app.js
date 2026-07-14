/* braindump PWA — dumb capture + view over a GitHub repo.
   This app never calls Claude or any AI API (see GOALS.md); all triage
   happens in Claude Code sessions against the same repo. */

'use strict';

const LS = {
  settings: 'bd.settings',
  queue: 'bd.queue',          // dumps that failed to upload (offline etc.)
  tasks: 'bd.tasksCache',     // last-seen tasks.json for offline rendering
  collapsed: 'bd.collapsed',  // per-section collapsed state
  answered: 'bd.answered',    // question task ids we've already answered
};

const $ = (sel) => document.querySelector(sel);

const load = (k, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v === null || v === undefined ? fallback : v;
  } catch { return fallback; }
};
const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let settings = load(LS.settings, null);
let answered = load(LS.answered, {});
let collapsed = load(LS.collapsed, { someday: true, done: true });

/* ---------------- GitHub contents API ---------------- */

const API = 'https://api.github.com';

function ghHeaders() {
  return {
    'Authorization': `Bearer ${settings.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ghGetFile(path) {
  const url = `${API}/repos/${settings.owner}/${settings.repo}/contents/${path}?ref=${settings.branch}`;
  const res = await fetch(url, { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  const j = await res.json();
  return { text: b64ToUtf8(j.content), sha: j.sha };
}

async function ghPutFile(path, text, message, sha) {
  const body = { message, content: utf8ToB64(text), branch: settings.branch };
  if (sha) body.sha = sha;
  const res = await fetch(`${API}/repos/${settings.owner}/${settings.repo}/contents/${path}`, {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`PUT ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ---------------- dumps ---------------- */

function newId(prefix) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

async function uploadDump(dump) {
  const label = dump.text.replace(/\s+/g, ' ').slice(0, 50);
  await ghPutFile(`data/inbox/${dump.id}.json`,
    JSON.stringify(dump, null, 2) + '\n', `dump: ${label}`);
}

async function saveDump(text, replyTo = null, source = 'pwa') {
  const dump = {
    id: newId('d'),
    text,
    created_at: new Date().toISOString(),
    source,
    reply_to: replyTo,
  };
  try {
    await uploadDump(dump);
    flashStatus('dumped ✓');
    return true;
  } catch (e) {
    const q = load(LS.queue, []);
    q.push(dump);
    store(LS.queue, q);
    renderQueueNote();
    flashStatus('offline — queued on this device');
    return false;
  }
}

async function flushQueue() {
  if (!settings) return;
  const q = load(LS.queue, []);
  if (!q.length) return;
  const remaining = [];
  for (const dump of q) {
    try { await uploadDump(dump); } catch { remaining.push(dump); }
  }
  store(LS.queue, remaining);
  renderQueueNote();
  if (q.length && !remaining.length) flashStatus('queued dumps synced ✓');
}

function renderQueueNote() {
  const n = load(LS.queue, []).length;
  $('#queueNote').textContent = n ? `${n} queued (offline)` : '';
}

/* ---------------- tasks ---------------- */

/* Optimistic concurrency: Claude Code and other devices also write
   tasks.json, so re-fetch and re-apply on sha conflicts. */
async function mutateTasks(mutator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, sha } = await ghGetFile('data/tasks.json');
    const data = JSON.parse(text);
    const summary = mutator(data);
    if (!summary) return data; // mutator decided nothing to do
    data.updated_at = new Date().toISOString();
    try {
      await ghPutFile('data/tasks.json',
        JSON.stringify(data, null, 2) + '\n', `app: ${summary}`, sha);
      store(LS.tasks, data);
      return data;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  throw new Error('tasks.json kept changing; try again');
}

function findTask(data, id) {
  return data.tasks.find((t) => t.id === id);
}

async function setTaskStatus(id, status) {
  const data = await mutateTasks((d) => {
    const t = findTask(d, id);
    if (!t || t.status === status) return null;
    t.status = status;
    t.updated_at = new Date().toISOString();
    t.done_at = status === 'done' ? t.updated_at : null;
    return `${status}: ${t.title.slice(0, 50)}`;
  });
  renderList(data);
}

/* ---------------- rendering ---------------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function chip(text, cls = '') {
  return el('span', { class: `chip ${cls}` }, text);
}

function fmtEffort(min) {
  if (!min) return null;
  return min >= 60 ? `~${+(min / 60).toFixed(1)}h` : `~${min}m`;
}

function dueChip(due) {
  if (!due) return null;
  const today = new Date().toISOString().slice(0, 10);
  const cls = due < today ? 'due overdue' : 'due';
  const label = due < today ? `overdue ${due}` : `due ${due}`;
  return chip(label, cls);
}

function taskMeta(t) {
  const meta = el('div', { class: 'meta' });
  if (t.category) meta.append(chip(t.category));
  const eff = fmtEffort(t.effort_min);
  if (eff) meta.append(chip(eff));
  const due = dueChip(t.due);
  if (due) meta.append(due);
  if (t.project) meta.append(chip(t.project));
  return meta;
}

function taskRow(t) {
  const body = el('div', { class: 'body' }, el('div', { class: 'title' }, t.title));
  body.append(taskMeta(t));
  if (t.notes && t.status !== 'done') {
    body.append(el('div', { class: 'notes' }, t.notes));
  }

  const row = el('div', { class: `task ${t.status === 'done' ? 'done' : ''}` });

  if (t.status === 'question') {
    const qbox = el('div', { class: 'question-box' },
      el('div', { class: 'q' }, `❓ ${t.question || 'Claude needs more info.'}`));
    if (answered[t.id]) {
      qbox.append(el('div', { class: 'answered-note' },
        'answer sent — will be picked up by the next triage run'));
    } else {
      const input = el('input', { placeholder: 'answer…', autocapitalize: 'sentences' });
      const send = el('button', {
        class: 'primary',
        onclick: async () => {
          const text = input.value.trim();
          if (!text) return;
          send.disabled = true;
          await saveDump(text, t.id);
          answered[t.id] = true;
          store(LS.answered, answered);
          renderList(load(LS.tasks, null));
        },
      }, 'send');
      qbox.append(el('div', { class: 'answer-row' }, input, send));
    }
    body.append(qbox);
    row.append(body);
    return row;
  }

  if (t.status === 'suggested') {
    body.append(el('div', { class: 'suggest-actions' },
      el('button', { class: 'primary', onclick: () => setTaskStatus(t.id, 'todo').catch(flashError) }, 'accept'),
      el('button', { class: 'ghost', onclick: () => setTaskStatus(t.id, 'dropped').catch(flashError) }, 'dismiss'),
    ));
    row.append(body);
    return row;
  }

  const cb = el('input', { type: 'checkbox' });
  cb.checked = t.status === 'done';
  cb.addEventListener('change', () => {
    setTaskStatus(t.id, cb.checked ? 'done' : 'todo').catch((e) => {
      cb.checked = !cb.checked;
      flashError(e);
    });
  });
  row.append(cb, body);
  return row;
}

const SECTIONS = [
  { key: 'questions', title: 'needs your answer', cls: 'questions',
    filter: (t) => t.status === 'question' },
  { key: 'today', title: 'today', cls: 'today',
    filter: (t) => t.status === 'todo' && t.bucket === 'today' },
  { key: 'week', title: 'this week', cls: '',
    filter: (t) => t.status === 'todo' && t.bucket === 'week' },
  { key: 'suggested', title: 'claude suggests', cls: '',
    filter: (t) => t.status === 'suggested' },
  { key: 'someday', title: 'someday', cls: '',
    filter: (t) => t.status === 'todo' && (t.bucket === 'someday' || !t.bucket) },
  { key: 'done', title: 'done', cls: '',
    filter: (t) => t.status === 'done' },
];

function renderList(data) {
  const root = $('#listSection');
  root.replaceChildren();
  if (!data || !data.tasks) {
    root.append(el('div', { class: 'empty' }, 'no data yet — check settings ⚙'));
    return;
  }

  const open = data.tasks.filter((t) => ['todo', 'question', 'suggested'].includes(t.status));
  if (!open.length) {
    root.append(el('div', { class: 'empty' }, 'nothing on the list. dump something ⚡'));
  }

  for (const sec of SECTIONS) {
    let tasks = data.tasks.filter(sec.filter);
    if (!tasks.length) continue;

    if (sec.key === 'done') {
      tasks = tasks.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || '')).slice(0, 20);
    } else {
      tasks = tasks.sort((a, b) => (a.priority || 3) - (b.priority || 3) ||
        (a.due || '9999').localeCompare(b.due || '9999'));
    }

    const isCollapsed = !!collapsed[sec.key];
    const header = el('div', { class: 'bucket-header' },
      el('h2', {}, sec.title),
      el('span', { class: 'count' }, sectionCount(sec.key, tasks)),
      el('span', { class: 'chev' }, isCollapsed ? '▸' : '▾'));
    header.addEventListener('click', () => {
      collapsed[sec.key] = !isCollapsed;
      store(LS.collapsed, collapsed);
      renderList(data);
    });

    const bucket = el('div', { class: `bucket ${sec.cls}` }, header);
    if (!isCollapsed) for (const t of tasks) bucket.append(taskRow(t));
    root.append(bucket);
  }
}

function sectionCount(key, tasks) {
  if (key === 'today') {
    const mins = tasks.reduce((s, t) => s + (t.effort_min || 0), 0);
    return mins ? `${tasks.length} · ~${mins} min` : `${tasks.length}`;
  }
  return `${tasks.length}`;
}

/* ---------------- work signal banner ---------------- */

async function loadWorkSignal() {
  try {
    const { text } = await ghGetFile('pipeline/config.json');
    const cfg = JSON.parse(text);
    const url = cfg.work_signal && cfg.work_signal.gist_raw_url;
    if (!url) return;
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const sig = await res.json();
    if (!sig.updated_at) return;
    const ageH = (Date.now() - Date.parse(sig.updated_at)) / 36e5;
    if (ageH > (cfg.work_signal.stale_after_hours || 36)) return;
    const bits = [`work: ${sig.workload || '?'}`];
    if (sig.urgent_count) bits.push(`${sig.urgent_count} urgent`);
    if (sig.next_hard_deadline) bits.push(`deadline ${sig.next_hard_deadline}`);
    const banner = $('#workBanner');
    banner.textContent = bits.join(' · ');
    banner.hidden = false;
  } catch { /* the signal is optional by design */ }
}

/* ---------------- status + settings UI ---------------- */

let flashTimer = null;
function flashStatus(msg, cls = 'flash-ok') {
  const line = $('#statusLine');
  line.textContent = msg;
  line.className = `muted ${cls}`;
  line.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { line.hidden = true; }, 4000);
}
function flashError(e) { flashStatus(String(e.message || e), 'flash-err'); }

function showSettings(show) {
  $('#settingsSection').hidden = !show;
  $('#listSection').hidden = show;
  $('#captureSection').hidden = show;
  if (show && settings) {
    $('#setOwner').value = settings.owner || '';
    $('#setRepo').value = settings.repo || 'braindump';
    $('#setBranch').value = settings.branch || 'main';
    $('#setToken').value = settings.token || '';
  }
}

async function saveSettings() {
  const candidate = {
    owner: $('#setOwner').value.trim(),
    repo: $('#setRepo').value.trim() || 'braindump',
    branch: $('#setBranch').value.trim() || 'main',
    token: $('#setToken').value.trim(),
  };
  const msg = $('#settingsMsg');
  if (!candidate.owner || !candidate.token) {
    msg.textContent = 'username and token are required';
    msg.className = 'muted flash-err';
    return;
  }
  msg.textContent = 'testing…';
  msg.className = 'muted';
  const prev = settings;
  settings = candidate;
  try {
    await ghGetFile('data/tasks.json');
    store(LS.settings, settings);
    msg.textContent = '';
    showSettings(false);
    flashStatus('connected ✓');
    await refresh();
  } catch (e) {
    settings = prev;
    msg.textContent = `failed: ${e.message}. check username/repo/token.`;
    msg.className = 'muted flash-err';
  }
}

/* ---------------- boot ---------------- */

async function refresh() {
  if (!settings) return;
  try {
    const { text } = await ghGetFile('data/tasks.json');
    const data = JSON.parse(text);
    store(LS.tasks, data);
    // prune answered-marks for questions that triage has since resolved
    const stillOpen = new Set(data.tasks.filter((t) => t.status === 'question').map((t) => t.id));
    for (const id of Object.keys(answered)) if (!stillOpen.has(id)) delete answered[id];
    store(LS.answered, answered);
    renderList(data);
  } catch (e) {
    renderList(load(LS.tasks, null)); // offline: render last-known
    flashStatus('offline — showing last synced list', 'flash-err');
  }
  loadWorkSignal();
  flushQueue();
}

function handleShareTarget() {
  const params = new URLSearchParams(location.search);
  const shared = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean).join(' — ').trim();
  if (shared) {
    $('#captureText').value = shared;
    history.replaceState(null, '', location.pathname);
    $('#captureText').focus();
  }
}

function init() {
  $('#dumpBtn').addEventListener('click', async () => {
    const box = $('#captureText');
    const text = box.value.trim();
    if (!text) return;
    if (!settings) { showSettings(true); return; }
    box.value = '';
    await saveDump(text);
  });

  $('#gearBtn').addEventListener('click', () =>
    showSettings($('#settingsSection').hidden));
  $('#saveSettingsBtn').addEventListener('click', saveSettings);

  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  renderQueueNote();
  handleShareTarget();

  if (!settings) {
    showSettings(true);
  } else {
    renderList(load(LS.tasks, null)); // instant paint from cache
    refresh();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
