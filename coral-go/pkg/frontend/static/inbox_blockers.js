/* What waits on a Needs you item (#11442), from what Coral already knows: a team's open tasks. A "for review" file stands in the way of the tasks whose blocked_by lists its task, and of its goal when its task is the goal's
 * last open one; an agent waiting on the person holds up its in-progress tasks and what waits on those. Said as one short phrase (the row's second line on a phone), and weighed so blockers sort first: a high-priority waiter,
 * then the most waiters. A run that failed and a commit that waits have nothing Coral records to say, so they say nothing. One query per team (the one the team Tasks page reads), kept 30 seconds; a team whose query fails says
 * nothing and the rows look as they did. Same board only: a task that waits across boards is not counted. Lazy: loaded by the Needs you folder when it has an item to ask about (inbox_sidebar.js). */
import { splitKey } from './server_base.js';
import { queryBoardTasks } from './task_list.js';

const OPEN = ['pending', 'blocked', 'in_progress', 'review_pending'];
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const KEEP_MS = 30000, KEEP_FAILED_MS = 10000, LIMIT = 200;

const teams = new Map(); // team key -> { at, tasks: [] | null }
let results = new Map(); // item key -> info

const waits = t => OPEN.includes(t.status);

/** The open tasks of `board` that list task `id` as an unsatisfied blocker (another board's blocker and the task itself do not count). */
export function dependentsOf(tasks, board, id) {
    const n = Number(id);
    return (tasks || []).filter(t => waits(t) && Number(t.id) !== n && Array.isArray(t.blocked_by)
        && t.blocked_by.some(d => d && Number(d.task_id) === n && (!d.board_id || d.board_id === board) && d.satisfied === false));
}

export function infoOf(waiters, closes) {
    if (!waiters.length && !closes) return null;
    const sorted = [...waiters].sort((a, b) => (RANK[a.priority] ?? 2) - (RANK[b.priority] ?? 2) || Number(a.id) - Number(b.id));
    return { count: sorted.length, first: sorted.length ? String(sorted[0].title || '') : '', high: sorted.some(t => (RANK[t.priority] ?? 2) <= 1), closes: closes || '' };
}

/** A review's: the tasks that wait on its task, and the goal it would close (its task is the last open one of that goal). null when nothing waits and no goal closes. */
export function reviewInfo(tasks, { board, taskId, goalId, goalTitle }) {
    if (!Number(taskId)) return null;
    const open = (tasks || []).filter(waits), mine = open.find(t => Number(t.id) === Number(taskId));
    const closes = mine && Number(goalId) && goalTitle && Number(mine.goal_id) === Number(goalId) && !open.some(t => Number(t.id) !== Number(taskId) && Number(t.goal_id) === Number(goalId)) ? String(goalTitle) : '';
    return infoOf(dependentsOf(tasks, board, taskId), closes);
}

/** An agent waiting on the person: its in-progress tasks and the tasks that wait on them (names are lower case). null when it has no task in progress. */
export function agentInfo(tasks, { board, names }) {
    const wanted = new Set((names || []).map(n => String(n).toLowerCase()).filter(Boolean));
    const own = (tasks || []).filter(t => t.status === 'in_progress' && wanted.has(String(t.assigned_to || '').toLowerCase()));
    if (!own.length) return null;
    const byId = new Map(own.map(t => [Number(t.id), t]));
    for (const t of own) for (const d of dependentsOf(tasks, board, t.id)) byId.set(Number(d.id), d);
    return infoOf([...byId.values()], '');
}

/** The phrase for a row: one waiter named, several counted, a high-priority one first, the goal it closes last. */
export function phraseOf(info, mark = t => t) {
    if (!info) return '';
    const first = mark(info.first).trim() || 'a task', closes = mark(info.closes).trim() || 'a goal'; // a title is an agent's text: the caller's mark writes out what hides or reorders it (markHidden strict, #11399; passed in so this lazy module imports nothing new)
    const core = info.count === 1 ? `“${first}” waits on this` : info.count > 1 ? `${info.count} tasks wait on this` : '';
    const text = core ? (info.high ? 'High priority: ' : '') + core + (info.closes ? ` · closes goal “${closes}”` : '') : `Closes goal “${closes}”`;
    return text;
}

/** The same, short, for a one-line row on a phone, where the whole sentence is cut off: "Blocks 3 tasks", "Blocks “Tag v2.0.10”", "Closes a goal". The whole sentence is the row's tooltip. */
export function shortPhraseOf(info, mark = t => t) {
    if (!info) return '';
    if (info.count === 1) return `Blocks “${mark(info.first).trim() || 'a task'}”`;
    if (info.count > 1) return `Blocks ${info.count} tasks`;
    return 'Closes a goal';
}

/** How much the row blocks, for the sort: a high-priority waiter first, then the count, then a goal that closes. */
export const weightOf = info => (info ? (info.high ? 1000 : 0) + info.count * 10 + (info.closes ? 1 : 0) : 0);

export const blockerOf = key => results.get(key) || null;

async function teamTasks(team) {
    const kept = teams.get(team);
    if (kept && Date.now() - kept.at < (kept.tasks ? KEEP_MS : KEEP_FAILED_MS)) return kept.tasks;
    let tasks = null;
    try {
        const j = await queryBoardTasks(team, [['board', team], ...OPEN.map(s => ['status', s]), ['limit', String(LIMIT)]]); // the query names the board by its key and keeps the server out of the name
        tasks = Array.isArray(j.tasks) ? j.tasks : null;
    } catch { tasks = null; }
    teams.set(team, { at: Date.now(), tasks });
    return tasks;
}

/** items: [{ key, kind: 'review' | 'agent', team, taskId, goalId, goalTitle, names }]. Asks each team once, works out what waits on each item, and says whether anything changed. */
export async function refreshBlockers(items) {
    const wanted = [...new Set(items.map(i => i.team).filter(Boolean))];
    const got = new Map(await Promise.all(wanted.map(async t => [t, await teamTasks(t)])));
    const next = new Map();
    for (const i of items) {
        const tasks = got.get(i.team);
        if (!tasks) continue;
        const board = splitKey(i.team).name;
        const info = i.kind === 'review' ? reviewInfo(tasks, { board, taskId: i.taskId, goalId: i.goalId, goalTitle: i.goalTitle }) : agentInfo(tasks, { board, names: i.names });
        if (info) next.set(i.key, info);
    }
    const same = next.size === results.size && [...next].every(([k, v]) => JSON.stringify(results.get(k)) === JSON.stringify(v));
    results = next;
    return !same;
}
