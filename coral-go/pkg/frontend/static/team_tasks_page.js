/* The team page's Tasks tab and a task's page (#7453): the right panel's Tasks tab moves here. The tab is a table of the whole team's tasks (Task, State, Assigned to, Goal, Priority) under filter chips with counts; a row's title opens the
 * task's own page (state, who, goal as a link, priority, description, when it started and ended), with a back link to the list (or to the goal it was opened from) and a pinned bar. Everything drawn is built with the DOM and
 * textContent: titles, bodies and names are written by agents. The task's own actions (Edit, Complete, Cancel, Publish, Nudge) stay in the task dialog for now ("Task actions"): they move onto this page with the Tasks build. Lazy: team_page.js imports it. */
import { boardFetch, pathId } from './server_base.js';
import { whenText } from './when_text.js';
import { importOnce } from './import_once.js';
const { teamTable, rowButton, rowFocusTarget, stateChip, el } = await importOnce('./team_table.js'); // lazy: its failure is retried
import { goalTitle, refreshGoalTitles, noGoalLabel } from './task_goals.js';
import { taskStatusWord, statusClass } from './goal_words.js';
import { state } from './state.js';

const PAGE = 50;
const FILTERS = [['all', 'All'], ['queued', 'Queued'], ['active', 'In progress'], ['blocked', 'Blocked'], ['review', 'In review'], ['done', 'Done']];
const model = { project: '', moreLoaded: false, rows: [], cursor: '', totalOpen: null, totalDone: null, filter: 'all', loading: false, failed: '', loadingMore: false, moreFailed: '' };
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

const counts = () => {
    const c = { all: 0, queued: 0, active: 0, blocked: 0, review: 0, done: 0 };
    for (const t of model.rows) { c.all++; c[bucket(t)]++; }
    if (model.totalOpen != null && model.totalDone != null) c.all = model.totalOpen + model.totalDone;
    if (model.totalDone != null) c.done = model.totalDone;
    return c;
};

function draw() {
    const body = root && root.querySelector('.team-tasks-body'); if (!body) return;
    const a = document.activeElement;
    const held = a && body.contains(a) ? { filter: a.dataset.filter, task: a.dataset.taskId, cls: a.className, text: a.textContent } : null;
    body.replaceChildren();
    const c = counts();
    const chips = el('div', 'goals-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Show tasks that are');
    for (const [key, label] of FILTERS) {
        const b = btn('goals-chip', `${label} ${c[key]}`, () => { model.filter = key; say(`${label}: ${c[key]} tasks`); draw(); });
        b.setAttribute('aria-pressed', String(model.filter === key)); b.dataset.filter = key;
        if (!c[key] && key !== 'all') b.classList.add('goals-chip-zero');
        chips.append(b);
    }
    const bar = el('div', 'goals-toolbar'); bar.append(chips); body.append(bar);
    if (model.failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.failed), btn('btn btn-small', 'Try again', loadTasks)); body.append(f); }
    if (model.loading) body.append(el('p', 'goals-note', 'Loading tasks…'));
    else if (!model.rows.length) { if (!model.failed) { const e = el('div', 'goals-empty'); e.append(el('p', null, 'No tasks yet')); body.append(e); } }
    else {
        const shown = model.rows.filter(t => model.filter === 'all' || bucket(t) === model.filter);
        if (!shown.length) {
            const e = el('div', 'goals-empty'); e.append(el('p', null, 'No tasks match this filter.'), btn('btn', 'Show all', () => { model.filter = 'all'; draw(); })); body.append(e);
        } else {
            body.append(teamTable({ label: `Tasks, ${shown.length}`, columns: ['Task', 'State', 'Assigned to', 'Goal', 'Priority'], rows: shown.map(rowOf) }));
        }
        if (model.cursor && (model.filter === 'all' || model.filter === 'done')) body.append(btn('btn goals-more', model.loadingMore ? 'Loading…' : 'Load more done tasks', loadMore));
        if (model.moreFailed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.moreFailed)); body.append(f); }
    }
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
export function showTasks(host, project, h = {}) {
    if (project !== model.project) Object.assign(model, { project, rows: [], cursor: '', moreLoaded: false, totalOpen: null, totalDone: null, filter: 'all', loading: false, failed: '', loadingMore: false, moreFailed: '' });
    hooks = h;
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const status = el('div', 'team-tasks-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        host.replaceChildren(el('div', 'goals-page goals-table-page'));
        host.firstChild.append(status, el('div', 'team-tasks-body'));
    }
    root = host.firstChild;
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
    fact(dl, 'Assigned to', task.assigned_to || 'Nobody yet');
    if (task.goal_id) {
        const g = btn('team-link', goalTitle(ctx.project, task.goal_id) || `Goal ${task.goal_id}`, () => ctx.openGoal(task.goal_id));
        fact(dl, 'Goal', g);
    } else fact(dl, 'Goal', noGoalLabel);
    fact(dl, 'Priority', priorityWord(task.priority));
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
