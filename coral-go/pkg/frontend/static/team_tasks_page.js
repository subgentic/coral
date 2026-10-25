/* The team page's Tasks tab and a task's page (#7453): the right panel's Tasks tab moves here. The tab is a table of the whole team's tasks (Task, State, Assigned to, Goal, Priority) under filter chips with counts; a row's title opens the
 * task's own page (state, who, goal as a link, priority, description, when it started and ended), with a back link to the list (or to the goal it was opened from) and a pinned bar. Everything drawn is built with the DOM and
 * textContent: titles, bodies and names are written by agents. The task's own actions (Edit, Complete, Cancel, Publish, Nudge) stay in the task dialog for now ("Task actions"): they move onto this page with the Tasks build. Lazy: team_page.js imports it. */
import { boardFetch, pathId, serverUrl, splitKey } from './server_base.js';
import { browserLocal } from './safe_storage.js';
import { pollEvery } from './overload.js';
import { whenText } from './when_text.js';
import { importOnce } from './import_once.js';
const { teamTable, rowButton, rowFocusTarget, stateChip, el } = await importOnce('./team_table.js'); // lazy: its failure is retried
import { goalTitle, refreshGoalTitles, noGoalLabel } from './task_goals.js';
import { taskStatusWord, statusClass } from './goal_words.js';
import { state } from './state.js';
const { buildTaskBar } = await importOnce('./task_bar.js'); // the old tab's search, filters and sort on the shared list bar (lazy: its failure is retried)
const TF = await importOnce('./task_filters.js');

const PAGE = 50;
const FILTERS = [['open', 'Open'], ['all', 'All'], ['queued', 'Queued'], ['active', 'In progress'], ['blocked', 'Blocked'], ['review', 'In review'], ['done', 'Done']];
const emptyQuery = () => ({ rows: [], phase: 0, cursor: '', total: null, doneTotal: 0, truncated: false, busy: false, error: '' });
// Hide completed (the old tab's toggle, same stored key): the Open chip, chosen until the person picks All; kept in this browser (#7453).
const HIDE_KEY = 'coral-hide-completed';
const startFilter = () => (browserLocal.get(HIDE_KEY) === 'false' ? 'all' : 'open');
const model = { project: '', filters: { ...TF.EMPTY }, q: emptyQuery(), seq: 0, moreLoaded: false, rows: [], cursor: '', totalOpen: null, totalDone: null, filter: startFilter(), loading: false, failed: '', loadingMore: false, moreFailed: '' };
let root = null, hooks = {};
const say = (t) => { const s = root && root.querySelector('.team-tasks-status'); if (s) { s.textContent = ''; s.textContent = t; } };
const bucket = (t) => { const w = taskStatusWord(t.status, t.review_requested); return { 'Queued': 'queued', 'In progress': 'active', 'Blocked': 'blocked', 'In review': 'review', 'Done': 'done' }[w] || 'queued'; };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

async function readJson(path) {
    const r = await boardFetch(model.project, path);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
}

/** Read the first page: every open task and the first of the done ones; "Load more" continues the done ones. */
export async function loadTasks() {
    const project = model.project; if (!project) return;
    if (TF.isQuery(model.filters)) return loadQuery(); // a search, a filter or an order the default list does not have: the task query
    model.loading = !model.rows.length;
    if (model.loading) draw();
    try {
        const json = await readJson(`/tasks?limit=${PAGE}`);
        if (project !== model.project) return;
        const rows = Array.isArray(json && json.tasks) ? json.tasks : [];
        const have = new Set(rows.map(t => t.id));
        const older = model.moreLoaded ? model.rows.filter(t => !have.has(t.id) && bucket(t) === 'done') : [];
        model.rows = rows.concat(older);
        if (!model.moreLoaded) model.cursor = typeof json.next_cursor === 'string' ? json.next_cursor : '';
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
        const json = await readJson(`/tasks?status=completed&limit=${PAGE}&cursor=${encodeURIComponent(model.cursor)}`);
        const have = new Set(model.rows.map(t => t.id));
        model.rows = model.rows.concat((json.tasks || []).filter(t => !have.has(t.id)));
        model.cursor = typeof json.next_cursor === 'string' ? json.next_cursor : '';
        model.moreLoaded = true;
    } catch { model.moreFailed = 'More tasks could not be read.'; }
    model.loadingMore = false;
    draw();
    say(`${model.rows.length - before} more tasks`);
    const first = root && root.querySelectorAll('tbody tr')[before];
    first?.querySelector('.team-row-btn')?.focus();
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
    loadTasks();
}
function ensureBar() {
    if (bar && barKey === model.project) return;
    barKey = model.project;
    bar = buildTaskBar(setFilters, { onPanel: open => { try { browserLocal.set(`coral-list-bar-open:team-tasks:${model.project}`, open ? '1' : ''); } catch { /* the panel is shut next time */ } } });
    bar.setOpen(browserLocal.get(`coral-list-bar-open:team-tasks:${model.project}`) === '1');
}
const rowsNow = () => (TF.isQuery(model.filters) ? model.q.rows : model.rows);

const counts = () => {
    const c = { open: 0, all: 0, queued: 0, active: 0, blocked: 0, review: 0, done: 0 };
    for (const t of rowsNow()) { c.all++; c[bucket(t)]++; }
    if (!TF.isQuery(model.filters)) {
        if (model.totalOpen != null && model.totalDone != null) c.all = model.totalOpen + model.totalDone;
        if (model.totalDone != null) c.done = model.totalDone;
    }
    c.open = c.all - c.done;
    return c;
};

function draw() {
    const body = root && root.querySelector('.team-tasks-body'); if (!body) return;
    ensureBar();
    const a = document.activeElement;
    const held = a && body.contains(a) && !bar.node.contains(a) ? { filter: a.dataset.filter, task: a.dataset.taskId, cls: a.className, text: a.textContent } : null;
    for (const c of [...body.children]) if (c !== bar.node) c.remove();
    if (bar.node.parentElement !== body) body.prepend(bar.node);
    const query = TF.isQuery(model.filters), L = model.q, all = rowsNow(), failed = query ? L.error : model.failed;
    const c = counts();
    const chips = el('div', 'goals-chips goals-chips-row'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Show tasks that are');
    for (const [key, label] of FILTERS) {
        const b = btn('goals-chip', `${label} ${c[key]}`, () => { model.filter = key; if (key === 'open' || key === 'all') browserLocal.set(HIDE_KEY, key === 'open' ? 'true' : 'false'); say(`${label}: ${c[key]} tasks`); draw(); });
        b.setAttribute('aria-pressed', String(model.filter === key)); b.dataset.filter = key;
        if (!c[key] && key !== 'all') b.classList.add('goals-chip-zero');
        chips.append(b);
    }
    const tools = el('div', 'goals-toolbar'); tools.append(chips, btn('btn btn-primary goals-new', 'New task', () => { (window.showCreateTaskModal || (() => {}))(); })); body.append(tools);
    chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    const count = query && L.total != null && L.total > all.length ? `Showing ${all.length} of ${L.total}${L.truncated ? '+' : ''}` : `${all.length} task${all.length === 1 ? '' : 's'}`;
    if (all.length && !model.loading) body.append(el('p', 'goals-note team-count-line', count));
    if (failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, failed), btn('btn btn-small', 'Try again', loadTasks)); body.append(f); }
    if (model.loading) body.append(el('p', 'goals-note', 'Loading tasks…'));
    else if (!all.length) { if (!failed) { const e = el('div', 'goals-empty'); e.append(el('p', null, query && TF.isFiltered(model.filters) ? 'No tasks match this search.' : 'No tasks yet')); body.append(e); } }
    else {
        const shown = all.filter(t => model.filter === 'all' || (model.filter === 'open' ? bucket(t) !== 'done' : bucket(t) === model.filter));
        if (!shown.length) {
            const e = el('div', 'goals-empty'); e.append(el('p', null, 'No tasks match this filter.'), btn('btn', 'Show all', () => { model.filter = 'all'; draw(); })); body.append(e);
        } else {
            body.append(teamTable({ label: `Tasks, ${shown.length}`, columns: ['Task', 'State', 'Assigned to', 'Goal', 'Priority'], rows: shown.map(rowOf) }));
        }
        if (query ? queryHasMore() : (model.cursor && (model.filter === 'all' || model.filter === 'done'))) body.append(btn('btn goals-more', model.loadingMore ? 'Loading…' : (query ? 'Load more' : 'Load more done tasks'), loadMore));
        if (model.moreFailed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.moreFailed)); body.append(f); }
    }
    bar.names([...new Set(all.map(t => t.assigned_to).filter(n => typeof n === 'string' && n))].sort().slice(0, 50)); // the names on screen, offered in the Agent field
    bar.set(model.filters, query ? { matched: L.total ?? all.length, all: L.total ?? all.length } : null);
    if (held) {
        const again = held.filter ? body.querySelector(`.goals-chip[data-filter="${CSS.escape(held.filter)}"]`) : held.task ? body.querySelector(`[data-task-id="${CSS.escape(held.task)}"]`) : [...body.querySelectorAll('button')].find(b => b.className === held.cls && b.textContent === held.text);
        (again || body.querySelector('.goals-chip[aria-pressed="true"]'))?.focus({ preventScroll: true });
    }
}

const priorityWord = (p) => { const s = String(p || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : ''; };

function rowOf(t) {
    const b = rowButton(t.title, `Open task #${t.id}: ${t.title}`); b.dataset.taskId = String(t.id);
    const first = el('span', 'team-row-cell'); first.append(b, el('span', 'team-row-sub', `#${t.id}`));
    const word = taskStatusWord(t.status, t.review_requested);
    const goalName = t.goal_id ? (goalTitle(model.project, t.goal_id) || `Goal ${t.goal_id}`) : '';
    first.append(el('span', 'team-row-phone', [t.assigned_to || 'Nobody yet', goalName].filter(Boolean).join(' · '))); // a phone's table folds who and which goal under the title
    let goal = el('span', 'team-muted', noGoalLabel);
    if (t.goal_id) {
        const title = goalTitle(model.project, t.goal_id) || `Goal ${t.goal_id}`;
        goal = btn('team-link', title, () => hooks.openGoal?.(t.goal_id)); goal.dataset.goalLink = String(t.goal_id);
    }
    return { key: `t${t.id}`, open: () => hooks.openTask?.(t), cells: [first, stateChip(word, statusClass(word)), t.assigned_to || 'Nobody yet', goal, priorityWord(t.priority)] };
}

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
    if (project !== model.project) { bar = null; Object.assign(model, { project, filters: TF.loadFilters(project, browserLocal), q: emptyQuery(), rows: [], cursor: '', moreLoaded: false, totalOpen: null, totalDone: null, filter: startFilter(), loading: false, failed: '', loadingMore: false, moreFailed: '' }); }
    hooks = h;
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const status = el('div', 'team-tasks-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        host.replaceChildren(el('div', 'goals-page goals-table-page'));
        host.firstChild.append(status, el('div', 'team-tasks-body'));
    }
    root = host.firstChild;
    watch();
    draw();
    return loadTasks();
}

export function focusTaskRow(id) { const b = root && rowFocusTarget(root, `t${id}`); if (b) { b.focus(); return true; } return false; }

/** A task by id: the list's item when it is read, else the route's. */
export async function readTask(project, id) {
    const have = model.project === project ? model.rows.find(t => t.id === Number(id)) : null;
    try {
        const r = await boardFetch(project, `/tasks/${pathId(id)}`);
        if (r.ok) return r.json();
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

/** Draw a task's page into `host`. ctx: { backLabel, onBack(), openGoal(id), project }. */
export function renderTaskPage(host, task, ctx) {
    host.replaceChildren();
    host.setAttribute('aria-label', `Task ${task.id}`);
    const back = el('button', 'goals-back'); back.type = 'button';
    const arrow = el('span', 'goals-back-arrow', '←'); arrow.setAttribute('aria-hidden', 'true');
    back.append(arrow, document.createTextNode(` ${ctx.backLabel}`));
    back.addEventListener('click', () => ctx.onBack());
    const page = el('div', 'goals-page goals-table-page team-task-page');
    const h = el('h2', 'goals-detail-title', `#${task.id} ${task.title}`); h.tabIndex = -1; h.id = 'team-task-title';
    const word = taskStatusWord(task.status, task.review_requested || (task.workflow && task.workflow.completion_review));
    const line = el('div', 'goals-detail-line'); line.append(stateChip(word, statusClass(word)));
    const dl = el('dl', 'goals-facts');
    const who = agentOf(ctx.project, task); // the agent that has it, when it runs here: its name opens it (the old subagent row's "Launched by", for a board's tasks)
    fact(dl, 'Assigned to', who ? btn('team-link', task.assigned_to, () => { window.switchNavTab?.('agents'); window.selectLiveSession?.(who.name, who.agent_type, who.session_id, who.server); }) : (task.assigned_to || 'Nobody yet'));
    if (task.goal_id) {
        const g = btn('team-link', goalTitle(ctx.project, task.goal_id) || `Goal ${task.goal_id}`, () => ctx.openGoal(task.goal_id));
        fact(dl, 'Goal', g);
    } else fact(dl, 'Goal', noGoalLabel);
    fact(dl, 'Priority', priorityWord(task.priority));
    if (Array.isArray(task.blocked_by) && task.blocked_by.length) fact(dl, 'Blocked by', task.blocked_by.map(d => `#${d.task_id}${d.title ? ' ' + d.title : ''}${d.satisfied ? ' (done)' : ''}`).join('\n'));
    if (Number.isFinite(task.cost_usd) && task.cost_usd > 0) fact(dl, 'Cost', `$${task.cost_usd.toFixed(2)}`);
    fact(dl, 'Created by', task.created_by);
    fact(dl, 'Created', whenText(task.created_at));
    if (task.claimed_at) fact(dl, 'Started', whenText(task.claimed_at));
    if (task.completed_at) fact(dl, 'Finished', whenText(task.completed_at));
    if (task.completion_message) fact(dl, 'Result', task.completion_message);
    page.append(back, h, line, dl);
    if (task.body) { const b = el('div', 'team-task-body'); b.append(el('h3', 'goals-sub', 'Description'), Object.assign(el('pre', 'team-task-text'), { textContent: task.body })); page.append(b); }
    const bar = el('div', 'goals-pinbar');
    const session = agentOf(ctx.project, task);
    if (session) bar.append(btn('btn', 'Open the agent', () => { window.switchNavTab?.('agents'); window.selectLiveSession?.(session.name, session.agent_type, session.session_id, session.server); })); // the agent that has the task, when it runs here
    bar.append(btn('btn', 'Task actions', () => {
        const existing = state.currentBoardTasks || [];
        if (!existing.find(t => t.id === task.id)) state.currentBoardTasks = [...existing, task]; // the task dialog reads the task from here (goals_view.js does the same)
        window.showTaskDetailModal?.(task.id);
    }));
    page.append(bar);
    host.append(page);
    h.focus({ preventScroll: true });
}
