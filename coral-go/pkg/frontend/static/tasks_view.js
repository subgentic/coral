/* The one Tasks view (#8060, the operator: "shoot for simplicity"): a list of tasks is drawn by tasksTable(scope, rows, options) and nowhere else. A scope says which columns the list has: the team's Tasks tab all of them, a task's
 * follow-ups, the Inbox's own scope ("mine": Team in, Assigned to out, they are all the person's), a goal's side column and a goal's page. One state word set, one chip, who as an avatar and a name, the priority as a word, the update
 * as a relative time. A task is the board's own record (status, review_requested, assigned_to, worked_by, completed_by, goal_id, priority, created_at, updated_at, board).
 *   tasksTable('team', rows, { ctx: { openGoal(goalId), goalTitleOf(goalId), noGoal, teamOf(task) }, open, state, ...dataTable options }) -> { el, bar, selectButton, ... } (a data_table)
 *   taskColumns(ctx, ['state', 'task', 'who', 'goal', 'priority', 'updated']) -> Column[] (the columns alone, for a surface that adds its own) */
import { taskStatusWord, statusClass } from './goal_words.js';
import * as DT from './data_table.js'; // static: a top-level await on a lazy import here would hold up every module that imports this one (the shape that froze startup in #7844 and #7904)
import { buildListBar } from './list_bar.js';
import { EMPTY, STATUSES, PRIORITIES, SORTS, STATUS_LABEL, PRIORITY_LABEL, SORT_LABEL, clean, chips, isFiltered, without } from './task_filters.js';

export const taskWord = (t) => taskStatusWord(t.status, t.review_requested);
export const taskKey = (t) => `t${t.id}`;
const isDone = (t) => t.status === 'completed';
/** Who did the work (the server's worked_by: the author of a reviewed task, not the orchestrator it was handed to); an older server has no worked_by: who completed a done task, else its assignee. */
export const doerOf = (t) => t.worked_by || (isDone(t) ? t.completed_by : '') || t.assigned_to;
export const whoText = (t) => { const w = doerOf(t); return isDone(t) ? (w ? `Done by ${w}` : 'Done') : (w || 'Nobody yet'); };
/** The reviewers a task row names (a list item's reviewers: the names of its current or last review round), none when the server sends none. */
const reviewersOf = (t) => (Array.isArray(t.reviewers) ? t.reviewers.map(r => String(r && r.name !== undefined ? r.name : r || '').trim()).filter(Boolean) : []);
/** Who a row's Assigned to cell says, in words: the doer ("Done by Dev", "Dev"), then the reviewers ("reviewed by QA" once done, "review by QA" before). It is the circles' accessible name and hover text (#8492). */
const whoWords = (t) => { const rv = reviewersOf(t); return rv.length ? `${whoText(t)}, ${isDone(t) ? 'reviewed by' : 'review by'} ${rv.join(', ')}` : whoText(t); };
export const priorityWord = (p) => { const s = String(p || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : ''; };
const STATE_RANK = { 'In progress': 0, 'In review': 1, 'Blocked': 2, 'Queued': 3, 'Done': 4 };
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** The Who cell: the person as circles named in words (DT.avatars), or "Nobody yet" in words when no one has the task. The dock's list draws the same one (#8507). */
export const whoCell = (t) => (doerOf(t) ? DT.avatars([{ name: doerOf(t) }, ...reviewersOf(t).map(name => ({ name, review: true }))], whoWords(t)) : whoText(t));

export function taskColumns(ctx, keys = ['state', 'task', 'who', 'goal', 'priority', 'updated']) {
    const all = {
        state: { key: 'state', label: 'State', cell: (t) => DT.chip(taskWord(t), statusClass(taskWord(t))), sort: true, sortValue: (t) => STATE_RANK[taskWord(t)] ?? 9, line: 2 },
        task: { key: 'task', label: 'Task', primary: true, width: 'grow', sort: true, sortValue: (t) => t.title, line: 1,
            cell: (t) => { const c = DT.el('span', 'dt-title-cell'); const b = DT.primaryButton(t.title, `Open task #${t.id}: ${t.title}`); b.dataset.taskId = String(t.id); c.append(DT.el('span', 'dt-id', `#${t.id}`), b); return c; } },
        who: { key: 'who', label: 'Who', sort: true, sortValue: (t) => doerOf(t) || '', line: 2, width: '6rem', cell: (t) => whoCell(t) },
        goal: { key: 'goal', label: 'Goal', sort: true, sortValue: (t) => (t.goal_id ? ctx.goalTitleOf(t.goal_id) : ''), line: 0,
            cell: (t) => { if (!t.goal_id) return ctx.noGoal || 'No goal'; const l = DT.link(ctx.goalTitleOf(t.goal_id), () => ctx.openGoal?.(t.goal_id)); l.dataset.goalLink = String(t.goal_id); return l; } },
        team: { key: 'team', label: 'Team', sort: true, sortValue: (t) => (ctx.teamOf ? ctx.teamOf(t) : t.board || ''), line: 0, cell: (t) => (ctx.teamOf ? ctx.teamOf(t) : t.board || '') },
        priority: { key: 'priority', label: 'Priority', tone: 'tertiary', sort: true, sortValue: (t) => PRIORITY_RANK[String(t.priority || '').toLowerCase()] ?? 3, line: 2, when: (t) => String(t.priority || '').toLowerCase() === 'high', cell: (t) => priorityWord(t.priority) },
        updated: { key: 'updated', label: 'Updated', tone: 'tertiary', align: 'end', sort: 'date', sortValue: (t) => t.updated_at || t.created_at || '', line: 1, firstDir: 'desc', cell: (t) => DT.timeCell(t.updated_at || t.created_at) },
    };
    return keys.map(k => all[k]);
}

/** The columns of each scope, in order; a narrow box (the goal's column, a task's follow-ups) folds them to the two-line row, so the order is also the order of the lines. */
export const SCOPES = {
    team: ['state', 'task', 'who', 'goal', 'priority', 'updated'],
    mine: ['state', 'task', 'priority', 'team', 'updated'],
    goal: ['state', 'task', 'who', 'priority'],
    'goal-page': ['task', 'state'],
    'follow-ups': ['state', 'task', 'who'],
    agent: ['state', 'task'], // an agent's own dock: every row is that agent's, so no Assigned to
    'agent-team': ['state', 'task', 'who'], // the dock of a team lead lists several agents' tasks
};

/** A task list as the shared table: the scope's columns, the task's own key and name, and everything else (open, state, selectable, bare, sortBar, ...) as the data_table takes it. `tweak(columns)` lets a surface add a column of
 *  its own (a goal's page adds the Open the agent action) and may return the new array. */
export function tasksTable(scope, rows, { ctx = {}, tweak, ...table } = {}) {
    const keys = SCOPES[scope];
    if (!keys) throw new Error(`tasksTable: no scope "${scope}"`);
    let columns = taskColumns(ctx, keys);
    if (tweak) columns = tweak(columns) || columns;
    return DT.dataTable({ label: `Tasks, ${rows.length}`, rowKey: taskKey, rowName: (t) => `#${t.id} ${t.title}`, ...table, columns, rows });
}

// ── the one toolbar (#8119): Search, Filters, + Task, on every scope that has a list bar ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SPEC = {
    idp: 'tk',
    noun: 'task',
    hideCount: true,
    label: 'Search and filter tasks',
    searchLabel: 'Search tasks',
    placeholder: 'Search tasks',
    collapsible: true, // the agents tab's pattern (#5293): one icon opens Filters and Sort
    sorts: { values: SORTS, labels: SORT_LABEL, aria: 'Sort tasks' },
    fields: [
        { type: 'select', key: 'status', id: 'tk-status', label: 'Status', values: STATUSES, labels: STATUS_LABEL, any: 'Any status' },
        { type: 'select', key: 'priority', id: 'tk-priority', label: 'Priority', values: PRIORITIES, labels: PRIORITY_LABEL, any: 'Any priority' },
        { type: 'text', key: 'assignee', id: 'tk-assignee', className: 'list-bar-by', label: 'Agent', max: 80, placeholder: 'Agent name', datalist: 'tk-assignee-list' },
        { type: 'date', key: 'from', id: 'tk-from', label: 'Updated since' },
    ],
    model: { EMPTY, clean, chips, isFiltered, without },
};

// The team page's Tasks tab (#7782): no Status field (the state pills above the list are the status), the goal as a select (the page fills its options: No goal, then the team's goals with their task counts), the agent
// as a select of the team's members, and the fields two to a line. The board's own Tasks panel (task_list.js) keeps the full set.
const TEAM_SPEC = {
    ...SPEC,
    compactPanel: true,
    sorts: null, // one sort on this tab: the table's own sortable heads (the order it opens in is Open first); the panel has none (#7883)
    doneButton: true, // a phone's panel closes with Done (#7883)
    chipsElsewhere: true, // the page puts every filter that is on as a chip on its toolbar line
    fields: [
        SPEC.fields[1],
        { type: 'select', key: 'goal', id: 'tk-goal', label: 'Goal', values: [], labels: {}, any: 'Any goal' },
        { type: 'select', key: 'assignee', id: 'tk-assignee', label: 'Agent', values: [], labels: {}, any: 'Any agent' },
        SPEC.fields[3],
    ],
};

// The dock's Tasks panel (#7924): the one top row (the search, the Filters icon, + Task), so the bar has a slot for the owner's button after the icon; Hide done is the owner's extra in the panel.
const DOCK_SPEC = {
    ...SPEC,
    headerSlots: true,
    // Agent is a select of the dock's agents, as on the main Tasks tab (#8003): the owner fills its options (the board's members and whoever has a task)
    fields: [SPEC.fields[0], SPEC.fields[1], { type: 'select', key: 'assignee', id: 'tk-assignee', label: 'Agent', values: [], labels: {}, any: 'Any agent' }, SPEC.fields[3]],
};


// Inbox tasks belong to the person across teams: no assignee or goal field, and no create action.
const MINE_SPEC = { ...TEAM_SPEC, idp: 'inbox-tk', chipsElsewhere: false, fields: [SPEC.fields[1], SPEC.fields[3]].map(field => ({ ...field, id: field.id.replace('tk-', 'inbox-tk-') })) };

const TOOLBAR_SPECS = { mine: MINE_SPEC, team: TEAM_SPEC, agent: DOCK_SPEC, 'agent-team': DOCK_SPEC };

/** The Tasks list's search box, Filters panel and chips on the shared list bar, for a scope: onChange(filters) is called with the new, clean filters when the person changes anything (typing after a short pause). The team tab
 *  adds its state pills and chips to the bar's row (team_toolbar.js adopt); the dock puts + Task in the bar's header slot; both end the row with newTaskButton. A scope with no toolbar (a goal's column) throws. */
export function tasksToolbar(scope, onChange, hooks = {}) {
    const spec = TOOLBAR_SPECS[scope];
    if (!spec) throw new Error(`tasksToolbar: scope "${scope}" has no toolbar`);
    return buildListBar(spec, onChange, hooks);
}

/** The one + Task button: the same words, name, tooltip and action on every list of tasks. `small` is the dock's compact size. It opens the create-task dialog (the data-on-click action). */
export function newTaskButton({ small = false } = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `btn btn-primary btn-create-task${small ? ' btn-small' : ' goals-new'}`; b.textContent = '+ Task';
    b.title = 'Create task'; b.setAttribute('aria-label', 'New task'); b.setAttribute('data-on-click', 'task-create-show');
    return b;
}
