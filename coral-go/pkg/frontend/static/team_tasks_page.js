/* The team page's Tasks tab and a task's page (#7453): the right panel's Tasks tab moves here. The tab is a table of the whole team's tasks (Task, State, Assigned to, Goal, Priority) under filter chips with counts; a row's title opens the
 * task's own page (state, who, goal as a link, priority, description, when it started and ended), with a back link to the Tasks list and a pinned bar. Everything drawn is built with the DOM and
 * textContent: titles, bodies and names are written by agents. The task's own actions (Edit, Complete, Cancel, Publish, Nudge) stay in the task dialog for now ("Task actions"): they move onto this page with the Tasks build. Lazy: team_page.js imports it. */
import { boardFetch, pathId, serverUrl, splitKey } from './server_base.js';
import { browserLocal } from './safe_storage.js';
import { pollEvery } from './overload.js';
import { whenText } from './when_text.js';
import { importOnce } from './import_once.js';
const { rowFocusTarget, stateChip, el } = await importOnce('./team_table.js'); // lazy: its failure is retried
const DT = await importOnce('./data_table.js'); // the one table (#7743)
const TV = await importOnce('./tasks_view.js'); // the one Tasks view: a task list is drawn by tasksTable
const TB = await importOnce('./task_bulk.js'); // what the selection bar does to the selected tasks
const Toolbar = await importOnce('./team_toolbar.js'); // the one toolbar of the team tabs (#7717)
import { goalTitle, refreshGoalTitles, readGoal, readGoalChoices, noGoalLabel } from './task_goals.js';
import { taskStatusWord, statusClass } from './goal_words.js';
import { state } from './state.js';
const { needsReview } = await importOnce('./review_pool.js');
import { showToast } from './utils.js';
import { foldWayBack } from './way_back.js';
const TF = await importOnce('./task_filters.js');
const { renderSafe } = await importOnce('./safe_markdown.js'); // the Inbox's renderer (DOM-built, no markup from text): a task reads the same on both pages
const { loadSafeMarkdown } = await importOnce('./vendor_loader.js');

const PAGE = 50;
const REREAD_PAGES = 5; // a refresh reads at most this many loaded pages again: a person who scrolled a big board to its end does not make 30 requests every 10 s (#9121); the pages beyond are dropped, Load more fetches them again
const FILTERS = [['open', 'Open'], ['all', 'All'], ['queued', 'Queued'], ['active', 'In progress'], ['blocked', 'Blocked'], ['review', 'In review'], ['needs_review', 'Needs review'], ['done', 'Done']];
const PHONE = matchMedia('(max-width: 760px)'); // the team page's phone layout (team_page.css)
let phoneWatched = false, newTask = null; // one New task button, moved between the search row and the chips' row
const emptyQuery = () => ({ rows: [], phase: 0, cursor: '', total: null, doneTotal: 0, truncated: false, busy: false, error: '' });
// Hide completed (the old tab's toggle, same stored key): the Open chip, chosen until the person picks All; kept in this browser (#7453).
const HIDE_KEY = 'coral-hide-completed';
const startFilter = () => (browserLocal.get(HIDE_KEY) === 'false' ? 'all' : 'open');
const model = { dt: DT.tableState(), choices: null, project: '', filters: { ...TF.EMPTY }, q: emptyQuery(), seq: 0, moreLoaded: false, extraPages: 0, rows: [], cursor: '', totalOpen: null, totalDone: null, filter: startFilter(), loading: false, failed: '', loadingMore: false, moreFailed: '' };
let root = null, hooks = {};
const say = (t) => { const s = root && root.querySelector('.team-tasks-status'); if (s) { s.textContent = ''; s.textContent = t; } };
const bucket = (t) => { const w = taskStatusWord(t.status, t.review_requested); return { 'Queued': 'queued', 'In progress': 'active', 'Blocked': 'blocked', 'In review': 'review', 'Done': 'done' }[w] || 'queued'; };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

async function readJson(path) {
    const r = await boardFetch(model.project, path);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
}

/** The description as the Inbox shows it (Markdown: bullets, not raw hyphens). The text is on screen as plain text first; the rendered DOM replaces it when the renderer is there, with the Inbox's link policy
 *  (an artifact link only when this server has it). A failure leaves the plain text, never markup. */
async function renderTaskText(host, text) {
    try {
        await loadSafeMarkdown().catch(() => {});
        let opts;
        try { const { artifactLinkPolicy } = await importOnce('./inbox_coral.js'); const policy = await artifactLinkPolicy(text); if (typeof policy === 'function') opts = { linkPolicy: policy }; } catch { /* links stay as the renderer's default has them */ }
        const { node, partial } = renderSafe(text, opts);
        if (partial || !host.isConnected) return; // the renderer did not load: the plain text stays; or the page was left
        node.classList.add('team-task-md'); host.replaceWith(node);
    } catch { /* the plain text stays */ }
}

/** Read the first page: the first 50 open tasks (every open task when they fit, and then the first of the done ones); "Load more" continues the open tasks, then the done ones (#9121). A refresh reads again as many pages as were loaded. */
export async function loadTasks() {
    const project = model.project; if (!project) return;
    if (TF.isQuery(model.filters)) return loadQuery(); // a search, a filter or an order the default list does not have: the task query
    model.loading = !model.rows.length;
    if (model.loading) draw();
    try {
        const json = await readJson(`/tasks?limit=${PAGE}`);
        if (project !== model.project) return;
        let rows = Array.isArray(json && json.tasks) ? json.tasks : [];
        let cursor = typeof json.next_cursor === 'string' ? json.next_cursor : '';
        const depth = model.moreLoaded ? model.extraPages : 0, reread = Math.min(depth, REREAD_PAGES);
        for (let i = 0; i < reread && cursor; i++) { // the pages the person loaded are read again with the first, so an open task that finished does not stay open on screen
            const next = await readJson(`/tasks?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`);
            if (project !== model.project) return;
            const have = new Set(rows.map(t => t.id));
            rows = rows.concat((next.tasks || []).filter(t => !have.has(t.id)));
            cursor = typeof next.next_cursor === 'string' ? next.next_cursor : '';
        }
        if (depth > reread) model.extraPages = reread; // the pages beyond the cap are dropped (rows and cursor end at the last page read again): "Load more" fetches them again, and no stale row comes back (#9153)
        model.rows = rows;
        model.cursor = cursor;
        model.totalOpen = Number.isFinite(json.total_open) ? json.total_open : null;
        model.totalDone = Number.isFinite(json.total_completed) ? json.total_completed : null;
        model.failed = '';
        await refreshGoalTitles(project).catch(() => {});
        hooks.onCount?.(model.totalOpen != null ? model.totalOpen : model.rows.filter(t => bucket(t) !== 'done').length);
    } catch (e) {
        if (project !== model.project) return;
        model.failed = `Tasks could not be read${e && e.message ? `: ${e.message}` : ''}`;
    }
    model.loading = false;
    draw();
}

async function loadMore() {
    if (TF.isQuery(model.filters)) return loadQuery({ append: true });
    if (!model.cursor || model.loadingMore) return;
    model.loadingMore = true; model.moreFailed = '';
    const before = model.rows.length;
    try {
        const json = await readJson(`/tasks?limit=${PAGE}&cursor=${encodeURIComponent(model.cursor)}`);
        const have = new Set(model.rows.map(t => t.id));
        model.rows = model.rows.concat((json.tasks || []).filter(t => !have.has(t.id)));
        model.cursor = typeof json.next_cursor === 'string' ? json.next_cursor : '';
        model.moreLoaded = true; model.extraPages++;
    } catch { model.moreFailed = 'More tasks could not be read.'; }
    model.loadingMore = false;
    draw();
    say(`${model.rows.length - before} more tasks`);
    const first = root && root.querySelectorAll('tbody tr')[before];
    first?.querySelector('.dt-primary')?.focus();
}

// ── search, filters and sort (#4744): with one on, the tasks come from the task query (the server matches every task of the board, not the loaded page); "Open first" is the open tasks, then the done ones ──

async function queryFetch(pairs) {
    const { server, name } = splitKey(model.project);
    const qs = new URLSearchParams(pairs.map(([k, v]) => [k, k === 'board' ? name : v])).toString();
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        const r = await fetch(serverUrl(`/api/board/tasks?${qs}`, server), { signal: ctrl.signal });
        if (!r.ok) { const err = new Error(`task search failed: ${r.status}`); err.status = r.status; throw err; }
        return await r.json();
    } finally { clearTimeout(timer); }
}

async function loadQuery({ append = false, quiet = false } = {}) {
    const project = model.project, f = model.filters, ph = TF.phases(f), seq = ++model.seq;
    if (!append && !quiet) model.q = Object.assign(emptyQuery(), { busy: true }); else model.q.busy = true; // a quiet read (the refresh) keeps what is drawn until the answer replaces it
    model.q.error = ''; model.loading = !append && !quiet; model.loadingMore = append;
    if (!quiet) draw();
    const L = model.q;
    try {
        if (append) {
            let phase = L.phase;
            if (ph && phase === 0 && !L.cursor) phase = 1;
            const pairs = TF.toParams(f, project, { statuses: ph ? ph[phase] : null });
            if (phase === L.phase && L.cursor) pairs.push(['cursor', L.cursor]);
            const data = await queryFetch(pairs);
            if (seq !== model.seq) return;
            const seen = new Set(L.rows.map(t => t.id));
            L.rows = L.rows.concat((data.tasks || []).filter(t => !seen.has(t.id))); L.cursor = data.next_cursor || ''; L.phase = phase; L.truncated = L.truncated || !!data.truncated;
        } else if (ph) {
            const [open, done] = await Promise.all([queryFetch(TF.toParams(f, project, { statuses: ph[0] })), queryFetch(TF.toParams(f, project, { statuses: ph[1], limit: 1 }))]);
            if (seq !== model.seq) return;
            L.rows = open.tasks || []; L.cursor = open.next_cursor || ''; L.phase = 0; L.doneTotal = done.total ?? 0; L.total = (open.total ?? L.rows.length) + L.doneTotal; L.truncated = !!(open.truncated || done.truncated);
        } else {
            const data = await queryFetch(TF.toParams(f, project));
            if (seq !== model.seq) return;
            L.rows = data.tasks || []; L.cursor = data.next_cursor || ''; L.total = data.total ?? L.rows.length; L.truncated = !!data.truncated; L.phase = 0;
        }
        await refreshGoalTitles(project).catch(() => {});
    } catch (e) {
        if (seq !== model.seq) return;
        L.error = e && e.status === 400 ? 'This search can not be run. Change it and try again.' : 'Could not search the tasks. Try again.';
    } finally {
        if (seq === model.seq) { L.busy = false; model.loading = false; model.loadingMore = false; draw(); }
    }
}
const queryHasMore = () => !!model.q.cursor || (!!TF.phases(model.filters) && model.q.phase === 0 && model.q.doneTotal > 0);

let bar = null, barKey = '';
function setFilters(next) {
    model.filters = next;
    TF.saveFilters(model.project, next, browserLocal);
    hooks.onFilters?.(TF.toQuery(next)); // the address keeps them (#7782)
    loadTasks();
}
function ensureBar() {
    if (bar && barKey === model.project) return;
    barKey = model.project;
    bar = TV.tasksToolbar('team', setFilters, { onPanel: open => { try { browserLocal.set(`coral-list-bar-open:team-tasks:${model.project}`, open ? '1' : ''); } catch { /* the panel is shut next time */ } } });
    applyChoices();
    bar.setOpen(browserLocal.get(`coral-list-bar-open:team-tasks:${model.project}`) === '1');
}
// The Goal and Agent selects of the Filters panel (#7782): the goals of the board with their task counts (No goal first, the open goals, then the closed ones under their own heading) and the board's members. Read
// when the tab is shown and again when it is older than a minute; until then the selects offer only what the stored filters name.
const CHOICES_MS = 60000;
function applyChoices() {
    if (!bar) return;
    const c = model.choices, f = model.filters;
    const values = [TF.NO_GOAL], labels = { [TF.NO_GOAL]: c && c.noGoalOpen != null ? `${noGoalLabel} (${c.noGoalOpen})` : noGoalLabel }, groups = {}, names = new Map();
    if (c) for (const [list, group] of [[c.open, 'Open goals'], [c.closed, 'Closed goals']]) for (const g of list) { const v = String(g.id); values.push(v); labels[v] = `${g.title} (${g.tasks})`; groups[v] = group; names.set(g.id, g.title); }
    if (f.goal && !values.includes(f.goal)) { values.push(f.goal); labels[f.goal] = `Goal ${f.goal}`; } // a goal the stored filter names stays selectable until the goals are read
    TF.setGoalNames(names);
    bar.setOptions('goal', values, labels, groups);
    const agents = [...new Set([...(c ? c.members : []), ...rowsNow().map(t => t.assigned_to), f.assignee].filter(n => typeof n === 'string' && n))].sort();
    bar.setOptions('assignee', agents, {});
}
async function loadChoices() {
    const project = model.project;
    model.choicesAt = Date.now();
    try {
        const { fetchSubscribers } = await importOnce('./board_fetch.js');
        const [g, subs] = await Promise.all([readGoalChoices(project), fetchSubscribers(project).catch(() => [])]);
        if (project !== model.project || !g.ok) return;
        const list = Array.isArray(subs) ? subs : (subs && Array.isArray(subs.subscribers) ? subs.subscribers : []);
        model.choices = { ...g, members: list.map(s => s && s.subscriber_id).filter(n => typeof n === 'string' && n) };
        applyChoices(); draw();
    } catch { model.choicesAt = 0; /* the selects keep what they have; the next time the tab is shown reads again */ }
}
const rowsNow = () => (TF.isQuery(model.filters) ? model.q.rows : model.rows);

const counts = () => {
    const c = { open: 0, all: 0, queued: 0, active: 0, blocked: 0, review: 0, needs_review: 0, done: 0 };
    for (const t of rowsNow()) { c.all++; c[bucket(t)]++; if (needsReview(t)) c.needs_review++; }
    if (!TF.isQuery(model.filters)) {
        if (model.totalOpen != null && model.totalDone != null) c.all = model.totalOpen + model.totalDone;
        if (model.totalDone != null) c.done = model.totalDone;
    }
    c.open = c.all - c.done;
    return c;
};

function draw() {
    const body = root && root.querySelector('.team-tasks-body'); if (!body) return;
    if (!phoneWatched) { phoneWatched = true; PHONE.addEventListener('change', () => draw()); }
    ensureBar();
    const a = document.activeElement;
    const held = a && body.contains(a) && !bar.node.contains(a) ? { filter: a.dataset.filter, task: a.dataset.taskId, cls: a.className, text: a.textContent } : null;
    for (const c of [...body.children]) if (c !== bar.node) c.remove();
    if (bar.node.parentElement !== body) body.prepend(bar.node);
    const query = TF.isQuery(model.filters), L = model.q, all = rowsNow(), failed = query ? L.error : model.failed;
    const c = counts();
    newTask = newTask || TV.newTaskButton();
    // The one toolbar line (#7717): the list bar's own row holds the search, the state pills (one compact select when they do not fit), the Filters icon and + Task at the right.
    Toolbar.adopt(bar.node.querySelector('.list-bar-search-row'), {
        pills: { label: 'Show tasks that are', current: model.filter, items: FILTERS.map(([key, label]) => ({ key, label, count: c[key] })),
            onPick: key => { model.filter = key; if (key === 'open' || key === 'all') browserLocal.set(HIDE_KEY, key === 'open' ? 'true' : 'false'); say(`${FILTERS.find(f => f[0] === key)[1]}: ${c[key]} tasks`); draw(); } },
        chips: TF.chips(model.filters).filter(c => c.key !== 'q').map(c => ({ label: c.label, aria: `Remove the filter: ${c.label}`, onRemove: () => { say(`Removed the filter: ${c.label}`); setFilters(TF.without(model.filters, c.key)); } })),
        action: newTask,
    });
    // No count line: the selected pill's number is the count of the table under it (it said every task read, 69, beside "Open 19"). Only a search that matched more than was read says so.
    if (query && L.total != null && L.total > all.length && all.length && !model.loading) body.append(el('p', 'goals-note team-count-line', `Showing ${all.length} of ${L.total}${L.truncated ? '+' : ''}`));
    if (failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, failed), btn('btn btn-small', 'Try again', loadTasks)); body.append(f); }
    if (model.loading) body.append(el('p', 'goals-note', 'Loading tasks…'));
    else if (!all.length) { if (!failed) { const e = el('div', 'goals-empty'); e.append(el('p', null, query && TF.isFiltered(model.filters) ? 'No tasks match this search.' : 'No tasks yet')); body.append(e); } }
    else {
        const shown = all.filter(t => (model.filter === 'all' || (model.filter === 'needs_review' ? needsReview(t) : model.filter === 'open' ? bucket(t) !== 'done' : bucket(t) === model.filter)));
        if (!shown.length) {
            const e = el('div', 'goals-empty'); e.append(el('p', null, 'No tasks match this filter.'), btn('btn', 'Show all', () => { model.filter = 'all'; draw(); })); body.append(e);
        } else {
            const row = bar.node.querySelector('.list-bar-search-row');
            const t = TV.tasksTable('team', shown, { ctx: rowCtx(), label: `Tasks, ${shown.length}`, open: (task) => hooks.openTask?.(task), state: model.dt,
                selectable: { contextKey: model.project, actions: TB.taskBulkActions(model.project, () => { model.dt.selected.clear(); loadTasks(); }), onChange: (keys) => Toolbar.mountSelection(row, keys.size ? t.bar : null) } }); // the selection bar takes the toolbar's line while tasks are selected
            Toolbar.mountSelection(row, model.dt.selected.size ? t.bar : null);
            row.querySelectorAll('.dt-select-toggle').forEach(b => b.remove());
            if (PHONE.matches) { if (newTask && newTask.parentElement === row) newTask.before(t.selectButton); else row.append(t.selectButton); } // a phone enters Select mode from the toolbar line, before the action that stays last
            body.append(t.el);
        }
        const openLeft = !query && !!model.cursor && model.totalOpen != null && model.rows.filter(t => bucket(t) !== 'done').length < model.totalOpen; // more open tasks than the pages loaded (#9121)
        if (query ? queryHasMore() : (model.cursor && (openLeft || model.filter === 'all' || model.filter === 'done'))) body.append(btn('btn goals-more', model.loadingMore ? 'Loading…' : (query ? 'Load more' : openLeft ? 'Load more open tasks' : 'Load more done tasks'), loadMore));
        if (model.moreFailed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.moreFailed)); body.append(f); }
    }
    bar.names([...new Set(all.map(t => t.assigned_to).filter(n => typeof n === 'string' && n))].sort().slice(0, 50)); // the names on screen, offered in the Agent field
    bar.set(model.filters, query ? { matched: L.total ?? all.length, all: L.total ?? all.length } : null);
    if (held) {
        const again = held.filter ? body.querySelector(`.goals-chip[data-filter="${CSS.escape(held.filter)}"]`) : held.task ? body.querySelector(`[data-task-id="${CSS.escape(held.task)}"]`) : [...body.querySelectorAll('button')].find(b => b.className === held.cls && b.textContent === held.text);
        (again || body.querySelector('.goals-chip[aria-pressed="true"]'))?.focus({ preventScroll: true });
    }
}

const rowCtx = () => ({ openTask: (t) => hooks.openTask?.(t), openGoal: (id) => hooks.openGoal?.(id), goalTitleOf: (id) => goalTitle(model.project, id) || `Goal ${id}`, noGoal: noGoalLabel });
const { doerOf, whoText, priorityWord } = TV; // the task's own page says the same words
const isDoneTask = (t) => t.status === 'completed';

/** Show the board's tasks in `host`. hooks: openTask(task), openGoal(id), onCount(openCount). */
// The tab keeps itself current (the old tab polled every 10 s): when the window comes back to the front, and on a slow read while it is on screen; a list the person paged further is left as it is.
let watching = false, reading = false;
function refresh() {
    if (!root || !root.isConnected || root.closest('[hidden]') || document.hidden || reading || !model.project) return;
    const query = TF.isQuery(model.filters);
    if ((query ? model.q.rows.length : model.rows.length) > PAGE * 2 || model.loading || model.loadingMore) return;
    reading = true;
    (query ? loadQuery({ quiet: true }) : loadTasks()).finally(() => { reading = false; });
}
function watch() {
    if (watching) return;
    watching = true;
    pollEvery(refresh, 15000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

export function showTasks(host, project, h = {}) {
    if (project !== model.project) { bar = null; Object.assign(model, { dt: DT.tableState(), choices: null, project, filters: { ...TF.loadFilters(project, browserLocal), sort: 'open' }, q: emptyQuery(), rows: [], cursor: '', moreLoaded: false, extraPages: 0, totalOpen: null, totalDone: null, filter: startFilter(), loading: false, failed: '', loadingMore: false, moreFailed: '' }); }
    hooks = h;
    if (!model.choices || Date.now() - (model.choicesAt || 0) > CHOICES_MS) loadChoices();
    if (h.query) model.filters = TF.fromQuery(h.query); // an address with filters in it (a link): they are the view, over what this browser kept
    if (h.noGoal) { model.filters = TF.clean({ ...TF.EMPTY, goal: TF.NO_GOAL }); model.filter = 'open'; } // opened from the Goals table's "N tasks have no goal" row: exactly those tasks, the Goal filter's No goal, a chip that removes it (#7717, #7782)
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const status = el('div', 'team-tasks-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        host.replaceChildren(el('div', 'goals-page goals-table-page'));
        host.firstChild.append(status, el('div', 'team-tasks-body'));
    }
    root = host.firstChild;
    watch();
    draw();
    hooks.onFilters?.(TF.toQuery(model.filters)); // the address says what is on screen
    return loadTasks();
}

export function focusTaskRow(id) { const b = root && rowFocusTarget(root, `t${id}`); if (b) { b.focus(); return true; } return false; }

/** A task by id: the list's item when it is read, else the route's. */
export async function readTask(project, id) {
    const have = model.project === project ? model.rows.find(t => t.id === Number(id)) : null;
    try {
        const r = await boardFetch(project, `/tasks/${pathId(id)}`);
        if (r.ok) {
            const task = await r.json();
            // A direct task mount has not loaded the team's list or its title cache.
            if (task.goal_id && !task.goal_title) {
                const goal = await readGoal(project, task.goal_id);
                if (goal?.title) task.goal_title = goal.title;
            }
            return task;
        }
    } catch { /* the list's item below */ }
    return have || null;
}

/** The live agent on this computer that has a task (its session, else its assignee's name on this board), or null: the page then has no Open the agent. */
function agentOf(project, task) {
    const live = state.liveSessions || [];
    if (task.session_id) { const bySession = live.find(s => s && s.session_id === task.session_id); if (bySession) return bySession; }
    const name = task.assigned_to;
    if (!name) return null;
    return live.find(s => s && (s.board_project === project || !s.board_project) && (s.display_name === name || s.name === name)) || null;
}

// ── a task's page ────────────────────────────────────────────────────────

function fact(dl, label, value) {
    if (value == null || value === '') return;
    dl.append(el('dt', null, label));
    const dd = el('dd'); if (value instanceof Node) dd.append(value); else dd.textContent = String(value);
    dl.append(dd);
}

/** Draw a task's page into `host`. ctx: { backLabel, onBack(), openGoal(id), project }. mode: 'view', 'edit' (the form), 'complete' (the completion form) or 'cancel' (the bar asks). */
/** The task's follow-ups (#7816, follow_ups[] of the task's own read: id, title, status, assigned_to): the tasks made from it, in the shared task table, each opening its own page; none: no section. */
function followUpsSection(task, ctx) {
    const list = Array.isArray(task.follow_ups) ? task.follow_ups : [];
    if (!list.length) return null;
    const open = list.filter(f => f.status !== 'completed' && f.status !== 'cancelled').length;
    const sec = el('div', 'team-task-followups');
    sec.append(el('h3', 'goals-sub', `Follow-ups (${list.length}${open ? `, ${open} open` : ''})`));
    const rows = list.map(f => ({ id: f.id, title: f.title, status: f.status, assigned_to: f.assigned_to }));
    const table = TV.tasksTable('follow-ups', rows, { label: `Follow-ups of task ${task.id}`, open: (f) => ctx.openTask?.(f), sortBar: false, bare: true });
    sec.append(table.el);
    return sec;
}

/** "Follow-up of task #P: <title>" under a follow-up's state line (#7829): the parent's number at once (the task's own read carries workflow.parent_task_id), its title when the parent has been read; a link to the parent's page when the page can open one. */
function followUpOfLine(parentId, ctx) {
    const p = el('p', 'goals-note team-task-follow-up-of');
    const label = `#${parentId}`;
    const link = ctx.openTask ? el('button', 'team-link', label) : el('span', null, label);
    if (ctx.openTask) { link.type = 'button'; link.addEventListener('click', () => ctx.openTask({ id: parentId })); }
    p.append(document.createTextNode('Follow-up of task '), link);
    readTask(ctx.project, parentId).then(parent => { if (parent && parent.title && link.isConnected) link.textContent = `${label}: ${parent.title}`; }).catch(() => { /* the number alone */ });
    return p;
}

export function renderTaskPage(host, task, ctx, mode = 'view') {
    host._taskConversation?.destroy({ keepDrafts: true });
    host._taskConversation = null;
    host.replaceChildren();
    host.setAttribute('aria-label', `Task ${task.id}`);
    const acts = { project: ctx.project, redraw: (t, m) => renderTaskPage(host, t || task, ctx, m), reload: (message) => reloadTask(host, task.id, ctx, message) };
    const back = el('button', 'goals-back'); back.type = 'button'; back.hidden = !!ctx.hideBack;
    const arrow = el('span', 'goals-back-arrow', '←'); arrow.setAttribute('aria-hidden', 'true');
    back.append(arrow, document.createTextNode(` ${ctx.backLabel}`));
    back.addEventListener('click', () => ctx.onBack());
    const page = el('div', 'goals-page goals-table-page team-task-page');
    const h = el('h2', 'goals-detail-title', `#${task.id} ${task.title}`); h.tabIndex = -1; h.id = 'team-task-title';
    if (task.version > 1) { const edited = el('span', 'text-muted-sm', ` edited, v${task.version}`); h.append(edited); }
 const word = taskStatusWord(task.status, task.review_requested || (task.workflow && task.workflow.completion_review));
    const line = el('div', 'goals-detail-line'); line.append(stateChip(word, statusClass(word)));
    if (ctx.teamLink) {
        const links = el('div', 'goal-back-row'), teamLink = el('a', 'goal-team-link inbox-team-link', 'Open on team page');
        teamLink.href = ctx.teamLink; teamLink.setAttribute('data-route', '');
        teamLink.setAttribute('aria-label', `Open task ${task.id} on its team page`);
        links.append(back, teamLink, h); page.append(links, line); // the title is in the row: a phone puts the way back beside it (foldWayBack below), the team link on the line under (team_page.css)
    } else page.append(back, h, line);
    page.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !e.defaultPrevented && !e.target.closest('input, textarea, select, [contenteditable="true"]')) { e.preventDefault(); e.stopPropagation(); ctx.onBack(); }
    });
    const parentId = task.workflow && Number(task.workflow.parent_task_id);
    if (parentId > 0) page.append(followUpOfLine(parentId, ctx)); // a follow-up says which task it is the follow-up of (#7829)
    const bar = el('div', 'goals-pinbar');
    let focus = ctx.focusTarget ? ctx.focusTarget() : ctx.teamLink ? back : h; // the Inbox's page opens on its Back link: a ring round the title's plain words is never drawn (#7404)
    if (mode === 'edit') {
        const loading = el('p', 'goals-note', 'Loading the task’s form…'); page.append(loading, bar);
        foldWayBack(page, '.goals-back', '.goals-detail-title');
    host.append(page);
        bar.append(btn('btn', 'Cancel', () => acts.redraw(task, 'view')));
        importOnce('./team_task_actions.js').then(async (A) => {
            const form = await A.editForm(task, acts);
            if (!loading.isConnected) return; // another page was shown meanwhile
            loading.replaceWith(form.node); form.mount();
            bar.append(btn('btn btn-primary', 'Save', () => form.save()));
            form.node.querySelector('#task-edit-title')?.focus();
        }).catch(() => { loading.textContent = 'The form could not be shown. Go back and try again.'; });
        h.focus({ preventScroll: true });
        return;
    }
    page.append(factsOf(task, ctx));
 if (task.version) { const versions = el('div', 'task-version-slot'); page.append(versions); importOnce('./task_versions.js').then(m => m.taskVersionHistory(ctx.project, task, acts.reload)).then(section => { if (versions.isConnected) versions.append(section); }).catch(() => {}); }
    if (task.body) { const b = el('div', 'team-task-body'), doc = Object.assign(el('pre', 'team-task-text'), { textContent: task.body }); b.append(el('h3', 'goals-sub', 'Description'), doc); page.append(b); renderTaskText(doc, task.body); }
    const followUps = followUpsSection(task, ctx); if (followUps) page.append(followUps);
    Promise.all([importOnce('./task_detail_html.js'), importOnce('./task_list.js')]).then(([m, list]) => { // the dialog's other sections, escaped as it escaped them
        if (!page.isConnected) return;
        const extra = el('div', 'team-task-extra'); extra.innerHTML = m.taskExtraHtml(task, task.status === 'in_progress' ? list._liveCosts[task.id] : null); // the running cost of a task in progress
        if (extra.children.length) bar.before(extra);
    }).catch(() => {});
    importOnce('./team_task_artifacts.js').then(m => m.taskArtifactsSection(ctx.project, task)).then(section => { // the artifacts an agent uploaded for the task, and the ones on its result (#7739); none: no section
        if (section && page.isConnected) bar.before(section);
    }).catch(() => {});
    if (mode === 'view' && task.assigned_to === 'Operator') {
        const conversation = el('div', 'inbox-task-mount');
        page.append(conversation);
        Promise.all([importOnce('./inbox_panel.js'), importOnce('./inbox_coral.js')]).then(([I, C]) => {
            if (!conversation.isConnected) return;
            const row = { ...task, project: ctx.project };
            const adapter = { ...C.coralInboxAdapter, listTasks: async () => [row] };
            host._taskConversation = I.mountInbox(conversation, adapter, { region: false, only: { project: ctx.project, id: task.id }, conversationOnly: true, poll: pollEvery });
        }).catch(() => { if (conversation.isConnected) conversation.textContent = 'The conversation could not be shown. Reload the page and try again.'; });
    }
    if (mode === 'cancel') {
        page.append(bar);
        importOnce('./team_task_actions.js').then(A => bar.append(A.cancelConfirm(task, acts)));
    } else if (mode === 'complete') {
        importOnce('./team_task_actions.js').then(A => {
            const form = A.completeForm(task, acts);
            bar.before(form.node); form.focus();
            bar.append(btn('btn', 'Back', () => acts.redraw(task, 'view')), btn('btn btn-success', 'Complete', () => form.submit()));
        });
        page.append(bar);
        focus = null;
    } else {
        importOnce('./team_task_actions.js').then(A => { for (const b of A.taskButtons(task, acts)) bar.append(b); }); // More, then the primary last; the agent that has the task is the Assigned-to link (#9076)
        page.append(bar);
    }
    foldWayBack(page, '.goals-back', '.goals-detail-title');
    host.append(page);
    if (focus) focus.focus({ preventScroll: true });
}

/** The facts of a task's page: who, goal, priority, who made it and when. (What the dialog showed beyond them is under them, taskExtraHtml.) */
function factsOf(task, ctx) {
    const dl = el('dl', 'goals-facts');
    const who = agentOf(ctx.project, task); // the agent that has it, when it runs here: its name opens it (the old subagent row's "Launched by", for a board's tasks)
    const doer = doerOf(task); // who did the work: for a done task the one who built it (the server's worked_by)
    fact(dl, isDoneTask(task) ? 'Done by' : 'Assigned to', who && !isDoneTask(task) ? btn('team-link', doer || task.assigned_to, () => { window.switchNavTab?.('agents'); window.selectLiveSession?.(who.name, who.agent_type, who.session_id, who.server); }) : (doer || (isDoneTask(task) ? 'Nobody recorded' : 'Nobody yet')));
    if (task.goal_id) {
        const g = btn('team-link', (ctx.goalTitleOf && ctx.goalTitleOf(task.goal_id)) || task.goal_title || goalTitle(ctx.project, task.goal_id) || `Goal ${task.goal_id}`, () => ctx.openGoal(task.goal_id)); // a goal's page already knows the titles
        fact(dl, 'Goal', g);
    } else fact(dl, 'Goal', noGoalLabel);
    const priority = el('span', null, priorityWord(task.priority)); priority.title = `Claim priority: ${task.priority || 'none'}`; // the dialog's name for it
    fact(dl, 'Priority', priority);
    fact(dl, 'Created by', task.created_by);
    fact(dl, 'Created', whenText(task.created_at));
    if (task.claimed_at) fact(dl, 'Started', whenText(task.claimed_at));
    if (task.completed_at) fact(dl, 'Finished', whenText(task.completed_at));
    if (task.completed_by) fact(dl, task.status === 'skipped' ? 'Cancelled by' : 'Finished by', task.completed_by);
    if (task.workflow && task.workflow.outcome === 'failed') fact(dl, 'Outcome', 'Failed'); // the dialog's "Result: Failed"
    if (task.completion_message) fact(dl, 'Result', task.completion_message);
    else if (task.workflow && task.workflow.outcome === 'failed') fact(dl, 'Result details', 'No failure reason was provided.');
    return dl;
}

/** After an action: the task is read again, the lists behind the page are refreshed, the page shows the new state, the toast says what was done. */
async function reloadTask(host, id, ctx, message) {
    const fresh = await readTask(ctx.project, id);
    if (message) showToast(message);
    loadTasks().catch(() => {});
    if (ctx.onChanged) ctx.onChanged(); // a page in another view (a goal's) reads its own lists again
    importOnce('./task_list.js').then(m => m.loadBoardTasks(ctx.project)).catch(() => {}); // the agent panel's list
    if (fresh && host.isConnected) renderTaskPage(host, fresh, ctx, 'view');
}
