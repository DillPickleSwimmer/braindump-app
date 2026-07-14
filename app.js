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
  feedback: 'bd.feedbackSent' // task id -> ISO ts of last feedback sent
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
let feedbackSent = load(LS.feedback, {});
let collapsed = load(LS.collapsed, { someday: true, doneToday: true, weekDone: true });

let currentView = 'now';       // now | week | month | all
let allFilter = 'open';        // open | question | suggested | done | dropped | everything
let lastData = load(LS.tasks, null);
let cfgCache = null;           // pipeline/config.json (categories order, signal url)
let pendingDumps = null;       // inbox dumps for the all view (null = not loaded)
let openFeedbackFor = null;    // task id with the feedback form expanded

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

function contentsUrl(path) {
  return `${API}/repos/${settings.owner}/${settings.repo}/contents/${path}`;
}

async function ghGetFile(path) {
  const res = await fetch(`${contentsUrl(path)}?ref=${settings.branch}`,
    { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  const j = await res.json();
  return { text: b64ToUtf8(j.content), sha: j.sha };
}

async function ghListDir(path) {
  const res = await fetch(`${contentsUrl(path)}?ref=${settings.branch}`,
    { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`LIST ${path} -> ${res.status}`);
  return res.json(); // [{name, path, sha, ...}]
}

async function ghPutFile(path, text, message, sha) {
  const body = { message, content: utf8ToB64(text), branch: settings.branch };
  if (sha) body.sha = sha;
  const res = await fetch(contentsUrl(path), {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`PUT ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ghDeleteFile(path, sha, message) {
  const res = await fetch(contentsUrl(path), {
    method: 'DELETE', headers: ghHeaders(),
    body: JSON.stringify({ message, sha, branch: settings.branch }),
  });
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`);
}

/* ---------------- dumps (thoughts, answers, feedback) ---------------- */

function newId(prefix) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

async function uploadDump(dump) {
  const label = `${dump.kind === 'feedback' ? 'feedback' : 'dump'}: ${dump.text.replace(/\s+/g, ' ').slice(0, 50)}`;
  await ghPutFile(`data/inbox/${dump.id}.json`,
    JSON.stringify(dump, null, 2) + '\n', label);
}

async function saveDump(fields) {
  const dump = {
    id: newId('d'),
    kind: 'thought',
    created_at: new Date().toISOString(),
    source: 'pwa',
    reply_to: null,
    ...fields,
  };
  try {
    await uploadDump(dump);
    flashStatus(dump.kind === 'feedback' ? 'feedback sent ✓' : 'dumped ✓');
    pendingDumps = null; // stale now
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

/* ---------------- task mutations ---------------- */

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
      lastData = data;
      return data;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  throw new Error('tasks.json kept changing; try again');
}

async function setTaskStatus(id, status) {
  const data = await mutateTasks((d) => {
    const t = d.tasks.find((x) => x.id === id);
    if (!t || t.status === status) return null;
    t.status = status;
    t.updated_at = new Date().toISOString();
    t.done_at = status === 'done' ? t.updated_at : null;
    return `${status}: ${t.title.slice(0, 50)}`;
  });
  render(data);
}

async function setTaskBucket(id, bucket) {
  const data = await mutateTasks((d) => {
    const t = d.tasks.find((x) => x.id === id);
    if (!t || t.bucket === bucket) return null;
    t.bucket = bucket;
    t.updated_at = new Date().toISOString();
    return `bucket -> ${bucket}: ${t.title.slice(0, 50)}`;
  });
  render(data);
}

/* ---------------- date helpers ---------------- */

function localYMD(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
const todayYMD = () => localYMD(new Date());
function isToday(iso) { return !!iso && localYMD(iso) === todayYMD(); }
function withinDays(iso, n) {
  if (!iso) return false;
  return (Date.now() - Date.parse(iso)) / 864e5 <= n;
}
function daysOld(iso) { return Math.floor((Date.now() - Date.parse(iso)) / 864e5); }

/* ---------------- shared rendering bits ---------------- */

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

function chip(text, cls = '') { return el('span', { class: `chip ${cls}` }, text); }

function fmtEffort(min) {
  if (!min) return null;
  return min >= 60 ? `~${+(min / 60).toFixed(1)}h` : `~${min}m`;
}

function dueChip(due) {
  if (!due) return null;
  const t = todayYMD();
  return due < t ? chip(`overdue ${due}`, 'due overdue') : chip(`due ${due}`, 'due');
}

function taskMeta(t, extra = []) {
  const meta = el('div', { class: 'meta' });
  for (const x of extra) if (x) meta.append(x);
  if (t.category) meta.append(chip(t.category));
  const eff = fmtEffort(t.effort_min);
  if (eff) meta.append(chip(eff));
  const due = dueChip(t.due);
  if (due) meta.append(due);
  if (t.project) meta.append(chip(t.project));
  return meta;
}

function sortOpen(tasks) {
  return tasks.sort((a, b) => (a.priority || 3) - (b.priority || 3) ||
    (a.due || '9999').localeCompare(b.due || '9999'));
}

function flagButton(t) {
  const sent = !!feedbackSent[t.id];
  return el('button', {
    class: `flag-btn ${sent ? 'sent' : ''}`,
    title: 'flag this task — tell Claude what’s off',
    onclick: () => {
      openFeedbackFor = openFeedbackFor === t.id ? null : t.id;
      render(lastData);
    },
  }, '⚑');
}

function feedbackForm(t) {
  const input = el('textarea', {
    rows: '2',
    placeholder: 'what’s off? wrong priority / too big a step / wrong bucket / bad idea…',
  });
  const send = el('button', {
    class: 'primary',
    onclick: async () => {
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      await saveDump({ kind: 'feedback', task_id: t.id, text });
      feedbackSent[t.id] = new Date().toISOString();
      store(LS.feedback, feedbackSent);
      openFeedbackFor = null;
      render(lastData);
    },
  }, 'send');
  return el('div', { class: 'feedback-box' },
    el('div', { class: 'answer-row' }, input, send),
    el('div', { class: 'muted' },
      'goes to the next triage run — it fixes this task and calibrates future runs'));
}

function questionBox(t) {
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
        await saveDump({ reply_to: t.id, text });
        answered[t.id] = true;
        store(LS.answered, answered);
        render(lastData);
      },
    }, 'send');
    qbox.append(el('div', { class: 'answer-row' }, input, send));
  }
  return qbox;
}

/* opts: {compact, manage} */
function taskRow(t, opts = {}) {
  const row = el('div', { class: `task ${t.status === 'done' ? 'done' : ''} ${opts.compact ? 'compact' : ''}` });
  const body = el('div', { class: 'body' }, el('div', { class: 'title' }, t.title));

  const statusChip = opts.manage && ['question', 'suggested', 'dropped'].includes(t.status)
    ? chip(t.status, 'status') : null;
  body.append(taskMeta(t, [statusChip]));

  if (!opts.compact && t.notes && t.status !== 'done') {
    body.append(el('div', { class: 'notes' }, t.notes));
  }

  if (t.status === 'question' && !answered[t.id]) {
    body.append(questionBox(t));
    row.append(body, flagButton(t));
    if (openFeedbackFor === t.id) body.append(feedbackForm(t));
    return row;
  }
  if (t.status === 'question' && answered[t.id]) {
    body.append(el('div', { class: 'answered-note' },
      'answered ✓ — processing on next triage'));
    row.append(body, flagButton(t));
    if (openFeedbackFor === t.id) body.append(feedbackForm(t));
    return row;
  }

  if (t.status === 'suggested') {
    body.append(el('div', { class: 'suggest-actions' },
      el('button', { class: 'primary', onclick: () => setTaskStatus(t.id, 'todo').catch(flashError) }, 'accept'),
      el('button', { class: 'ghost', onclick: () => setTaskStatus(t.id, 'dropped').catch(flashError) }, 'dismiss'),
    ));
    row.append(body, flagButton(t));
    if (openFeedbackFor === t.id) body.append(feedbackForm(t));
    return row;
  }

  if (t.status === 'dropped') {
    body.append(el('div', { class: 'manage-actions' },
      el('button', { class: 'ghost', onclick: () => setTaskStatus(t.id, 'todo').catch(flashError) }, 'restore')));
    row.append(body);
    return row;
  }

  // todo / done
  const cb = el('input', { type: 'checkbox' });
  cb.checked = t.status === 'done';
  cb.addEventListener('change', () => {
    setTaskStatus(t.id, cb.checked ? 'done' : 'todo').catch((e) => {
      cb.checked = !cb.checked;
      flashError(e);
    });
  });
  row.append(cb, body);

  if (opts.manage && t.status === 'todo') {
    const seg = el('div', { class: 'seg' });
    for (const b of ['today', 'week', 'someday']) {
      seg.append(el('button', {
        class: t.bucket === b ? 'on' : '',
        onclick: () => setTaskBucket(t.id, b).catch(flashError),
      }, b));
    }
    body.append(el('div', { class: 'manage-actions' }, seg,
      el('button', { class: 'ghost danger', onclick: () => setTaskStatus(t.id, 'dropped').catch(flashError) }, 'drop')));
  }

  if (!opts.compact || opts.manage) {
    row.append(flagButton(t));
    if (openFeedbackFor === t.id) body.append(feedbackForm(t));
  }
  return row;
}

function bucketSection(key, title, cls, tasks, renderRow, countLabel) {
  const isCollapsed = !!collapsed[key];
  const header = el('div', { class: 'bucket-header' },
    el('h2', {}, title),
    el('span', { class: 'count' }, countLabel ?? `${tasks.length}`),
    el('span', { class: 'chev' }, isCollapsed ? '▸' : '▾'));
  header.addEventListener('click', () => {
    collapsed[key] = !isCollapsed;
    store(LS.collapsed, collapsed);
    render(lastData);
  });
  const bucket = el('div', { class: `bucket ${cls}` }, header);
  if (!isCollapsed) for (const t of tasks) bucket.append(renderRow(t));
  return bucket;
}

function minutesLabel(tasks) {
  const mins = tasks.reduce((s, t) => s + (t.effort_min || 0), 0);
  return mins ? `${tasks.length} · ~${mins} min` : `${tasks.length}`;
}

/* ---------------- views ---------------- */

function renderNow(root, data) {
  const open = (f) => data.tasks.filter(f);

  const questions = open((t) => t.status === 'question' && !answered[t.id]);
  const today = sortOpen(open((t) => t.status === 'todo' && t.bucket === 'today'));
  const doneToday = open((t) =>
    (t.status === 'done' && isToday(t.done_at)) ||
    (t.status === 'question' && answered[t.id]))
    .sort((a, b) => (b.done_at || b.updated_at || '').localeCompare(a.done_at || a.updated_at || ''));
  const week = sortOpen(open((t) => t.status === 'todo' && t.bucket === 'week'));
  const suggested = open((t) => t.status === 'suggested');
  const someday = sortOpen(open((t) => t.status === 'todo' && (t.bucket === 'someday' || !t.bucket)));

  if (!questions.length && !today.length && !doneToday.length && !week.length && !suggested.length && !someday.length) {
    root.append(el('div', { class: 'empty' }, 'nothing on the list. dump something ⚡'));
    return;
  }

  const row = (t) => taskRow(t);
  if (questions.length) root.append(bucketSection('questions', 'needs your answer', 'questions', questions, row));
  if (today.length) root.append(bucketSection('today', 'today', 'today', today, row, minutesLabel(today)));
  if (doneToday.length) root.append(bucketSection('doneToday', 'completed today', 'completed', doneToday, row));
  if (week.length) root.append(bucketSection('week', 'this week', '', week, row));
  if (suggested.length) root.append(bucketSection('suggested', 'claude suggests', '', suggested, row));
  if (someday.length) root.append(bucketSection('someday', 'someday', '', someday, row));
}

function renderWeek(root, data) {
  const week = data.tasks.filter((t) => t.status === 'todo' && (t.bucket === 'today' || t.bucket === 'week'));
  const doneWeek = data.tasks.filter((t) => t.status === 'done' && withinDays(t.done_at, 7))
    .sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
  const nQuestions = data.tasks.filter((t) => t.status === 'question' && !answered[t.id]).length;

  root.append(el('div', { class: 'hint' },
    `this week: ${week.length} tasks · ~${week.reduce((s, t) => s + (t.effort_min || 0), 0)} min total` +
    (nQuestions ? ` · ${nQuestions} question${nQuestions > 1 ? 's' : ''} blocking (answer in now ⚡)` : '')));

  if (!week.length && !doneWeek.length) {
    root.append(el('div', { class: 'empty' }, 'nothing scheduled this week'));
    return;
  }

  const catOrder = (cfgCache && cfgCache.categories) || [];
  const cats = [...new Set(week.map((t) => t.category || 'uncategorized'))]
    .sort((a, b) => {
      const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });

  for (const cat of cats) {
    const tasks = sortOpen(week.filter((t) => (t.category || 'uncategorized') === cat));
    root.append(bucketSection(`wk-${cat}`, cat, '', tasks,
      (t) => taskRow(t, { compact: true }), minutesLabel(tasks)));
  }

  if (doneWeek.length) {
    root.append(bucketSection('weekDone', 'completed · last 7 days', 'completed', doneWeek,
      (t) => taskRow(t, { compact: true })));
  }
}

function renderMonth(root, data) {
  const openTodos = data.tasks.filter((t) => t.status === 'todo');
  if (!openTodos.length) {
    root.append(el('div', { class: 'empty' }, 'nothing open — enjoy it' ));
    return;
  }

  const horizon = new Date(Date.now() + 31 * 864e5).toISOString().slice(0, 10);
  const due = openTodos.filter((t) => t.due && t.due <= horizon)
    .sort((a, b) => a.due.localeCompare(b.due));
  if (due.length) {
    const sec = el('div', { class: 'bucket' },
      el('div', { class: 'bucket-header' }, el('h2', {}, 'deadlines · next 31 days'),
        el('span', { class: 'count' }, `${due.length}`)));
    for (const t of due) sec.append(taskRow(t, { compact: true }));
    root.append(sec);
  }

  const projects = new Map();
  for (const t of openTodos.filter((x) => x.project)) {
    const p = projects.get(t.project) || { count: 0, mins: 0, nextDue: null };
    p.count++; p.mins += t.effort_min || 0;
    if (t.due && (!p.nextDue || t.due < p.nextDue)) p.nextDue = t.due;
    projects.set(t.project, p);
  }
  if (projects.size) {
    root.append(el('div', { class: 'bucket-header' }, el('h2', {}, 'projects')));
    for (const [name, p] of [...projects.entries()].sort()) {
      root.append(el('div', { class: 'stat-row' }, el('span', {}, name),
        el('span', { class: 'right' },
          `${p.count} open · ~${p.mins} min${p.nextDue ? ` · next due ${p.nextDue}` : ''}`)));
    }
  }

  const byCat = new Map();
  for (const t of openTodos) {
    const c = t.category || 'uncategorized';
    const s = byCat.get(c) || { count: 0, mins: 0 };
    s.count++; s.mins += t.effort_min || 0;
    byCat.set(c, s);
  }
  root.append(el('div', { class: 'bucket-header' }, el('h2', {}, 'by category · all open')));
  for (const [name, s] of [...byCat.entries()].sort((a, b) => b[1].count - a[1].count)) {
    root.append(el('div', { class: 'stat-row' }, el('span', {}, name),
      el('span', { class: 'right' }, `${s.count} open · ~${s.mins} min`)));
  }

  const someday = openTodos.filter((t) => t.bucket === 'someday' || !t.bucket);
  if (someday.length) {
    const oldest = Math.max(...someday.map((t) => (t.created_at ? daysOld(t.created_at) : 0)));
    root.append(el('div', { class: 'stat-row' }, el('span', {}, 'someday parking lot'),
      el('span', { class: 'right' }, `${someday.length} items · oldest ${oldest}d`)));
  }
}

const ALL_FILTERS = ['open', 'question', 'suggested', 'done', 'dropped', 'everything'];

function renderAll(root, data) {
  // pending (not yet triaged) dumps
  const pendWrap = el('div', {});
  root.append(pendWrap);
  renderPendingDumps(pendWrap);

  const filterRow = el('div', { class: 'filter-row' });
  for (const f of ALL_FILTERS) {
    filterRow.append(el('button', {
      class: allFilter === f ? 'on' : '',
      onclick: () => { allFilter = f; render(lastData); },
    }, f));
  }
  root.append(filterRow);

  const match = (t) => {
    if (allFilter === 'everything') return true;
    if (allFilter === 'open') return t.status === 'todo';
    return t.status === allFilter;
  };
  let tasks = data.tasks.filter(match);
  tasks = allFilter === 'done'
    ? tasks.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''))
    : sortOpen(tasks);

  if (!tasks.length) {
    root.append(el('div', { class: 'empty' }, `no ${allFilter === 'everything' ? '' : allFilter + ' '}tasks`));
    return;
  }
  for (const t of tasks) root.append(taskRow(t, { manage: true }));
}

async function renderPendingDumps(wrap) {
  if (!pendingDumps) {
    try {
      const entries = (await ghListDir('data/inbox'))
        .filter((e) => e.name.endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20);
      pendingDumps = await Promise.all(entries.map(async (e) => {
        const { text } = await ghGetFile(e.path);
        return { ...JSON.parse(text), sha: e.sha, path: e.path };
      }));
    } catch { pendingDumps = []; }
  }
  if (!pendingDumps.length) return;

  wrap.append(el('div', { class: 'bucket-header' },
    el('h2', {}, 'waiting for triage'),
    el('span', { class: 'count' }, `${pendingDumps.length}`)));
  for (const d of pendingDumps) {
    const label = d.kind === 'feedback' ? `⚑ ${d.text}` : d.reply_to ? `↩ ${d.text}` : d.text;
    wrap.append(el('div', { class: 'pending-dump' },
      el('div', { class: 'txt' }, label,
        el('div', { class: 'when' }, new Date(d.created_at).toLocaleString())),
      el('button', {
        class: 'ghost danger',
        onclick: async (ev) => {
          if (!confirm('delete this dump before triage sees it?')) return;
          ev.target.disabled = true;
          try {
            await ghDeleteFile(d.path, d.sha, `app: delete dump ${d.id}`);
            pendingDumps = pendingDumps.filter((x) => x.id !== d.id);
            render(lastData);
          } catch (e) { flashError(e); }
        },
      }, 'delete')));
  }
}

/* ---------------- render dispatch ---------------- */

function render(data) {
  const root = $('#listSection');
  root.replaceChildren();
  if (!data || !data.tasks) {
    root.append(el('div', { class: 'empty' }, 'no data yet — check settings ⚙'));
    return;
  }
  if (currentView === 'now') renderNow(root, data);
  else if (currentView === 'week') renderWeek(root, data);
  else if (currentView === 'month') renderMonth(root, data);
  else renderAll(root, data);
}

function switchView(view) {
  currentView = view;
  openFeedbackFor = null;
  document.querySelectorAll('#viewNav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  $('#captureSection').hidden = view !== 'now';
  showSettings(false, false);
  if (view === 'all') pendingDumps = null;
  render(lastData);
}

/* ---------------- work signal banner ---------------- */

async function loadConfigAndSignal() {
  try {
    const { text } = await ghGetFile('pipeline/config.json');
    cfgCache = JSON.parse(text);
    const url = cfgCache.work_signal && cfgCache.work_signal.gist_raw_url;
    if (!url) return;
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const sig = await res.json();
    if (!sig.updated_at) return;
    const ageH = (Date.now() - Date.parse(sig.updated_at)) / 36e5;
    if (ageH > (cfgCache.work_signal.stale_after_hours || 36)) return;
    const bits = [`work: ${sig.workload || '?'}`];
    if (sig.urgent_count) bits.push(`${sig.urgent_count} urgent`);
    if (sig.next_hard_deadline) bits.push(`deadline ${sig.next_hard_deadline}`);
    const banner = $('#workBanner');
    banner.textContent = bits.join(' · ');
    banner.hidden = false;
  } catch { /* config/signal are optional for rendering */ }
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

function showSettings(show, rerender = true) {
  $('#settingsSection').hidden = !show;
  $('#listSection').hidden = show;
  $('#captureSection').hidden = show || currentView !== 'now';
  if (show && settings) {
    $('#setOwner').value = settings.owner || '';
    $('#setRepo').value = settings.repo || 'braindump';
    $('#setBranch').value = settings.branch || 'main';
    $('#setToken').value = settings.token || '';
  }
  if (!show && rerender) render(lastData);
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
    lastData = data;
    // prune local marks for tasks triage has since resolved/removed
    const stillQuestion = new Set(data.tasks.filter((t) => t.status === 'question').map((t) => t.id));
    for (const id of Object.keys(answered)) if (!stillQuestion.has(id)) delete answered[id];
    store(LS.answered, answered);
    const ids = new Set(data.tasks.map((t) => t.id));
    for (const id of Object.keys(feedbackSent)) if (!ids.has(id)) delete feedbackSent[id];
    store(LS.feedback, feedbackSent);
    render(data);
  } catch (e) {
    render(lastData); // offline: render last-known
    flashStatus('offline — showing last synced list', 'flash-err');
  }
  loadConfigAndSignal();
  flushQueue();
}

function handleShareTarget() {
  const params = new URLSearchParams(location.search);
  const shared = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean).join(' — ').trim();
  if (shared) {
    switchView('now');
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
    await saveDump({ text });
  });

  $('#gearBtn').addEventListener('click', () =>
    showSettings($('#settingsSection').hidden));
  $('#saveSettingsBtn').addEventListener('click', saveSettings);

  document.querySelectorAll('#viewNav button').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view)));

  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  renderQueueNote();
  handleShareTarget();

  if (!settings) {
    showSettings(true);
  } else {
    render(lastData); // instant paint from cache
    refresh();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
