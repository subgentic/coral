/* A task as a data_table row (#7743, generalising #7737's task_row.js): the columns the Tasks tab, the Inbox's Tasks group and a goal's column pick from. One state word set, one chip, who as an avatar and a name, the priority
 * as a word, the update as a relative time. A task is the board's own record (status, review_requested, assigned_to, worked_by, completed_by, goal_id, priority, created_at, updated_at, board).
 *   taskColumns({ openGoal(goalId), goalTitleOf(goalId), noGoal, teamOf(task) }, ['state', 'task', 'who', 'goal', 'priority', 'updated']) -> Column[] */
import { taskStatusWord, statusClass } from './goal_words.js';
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js'); // lazy: its failure is retried

export const taskWord = (t) => taskStatusWord(t.status, t.review_requested);
export const taskKey = (t) => `t${t.id}`;
const isDone = (t) => t.status === 'completed';
/** Who did the work (the server's worked_by: the author of a reviewed task, not the orchestrator it was handed to); an older server has no worked_by: who completed a done task, else its assignee. */
export const doerOf = (t) => t.worked_by || (isDone(t) ? t.completed_by : '') || t.assigned_to;
export const whoText = (t) => { const w = doerOf(t); return isDone(t) ? (w ? `Done by ${w}` : 'Done') : (w || 'Nobody yet'); };
export const priorityWord = (p) => { const s = String(p || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : ''; };
const STATE_RANK = { 'In progress': 0, 'In review': 1, 'Blocked': 2, 'Queued': 3, 'Done': 4 };
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export function taskColumns(ctx, keys = ['state', 'task', 'who', 'goal', 'priority', 'updated']) {
    const all = {
        state: { key: 'state', label: 'State', cell: (t) => DT.chip(taskWord(t), statusClass(taskWord(t))), sort: true, sortValue: (t) => STATE_RANK[taskWord(t)] ?? 9, line: 2 },
        task: { key: 'task', label: 'Task', primary: true, width: 'grow', sort: true, sortValue: (t) => t.title, line: 1,
            cell: (t) => { const c = DT.el('span', 'dt-title-cell'); const b = DT.primaryButton(t.title, `Open task #${t.id}: ${t.title}`); b.dataset.taskId = String(t.id); c.append(DT.el('span', 'dt-id', `#${t.id}`), b); return c; } },
        who: { key: 'who', label: 'Assigned to', sort: true, sortValue: (t) => doerOf(t) || '', line: 2, cell: (t) => (doerOf(t) ? DT.avatar(doerOf(t), whoText(t)) : whoText(t)) },
        goal: { key: 'goal', label: 'Goal', sort: true, sortValue: (t) => (t.goal_id ? ctx.goalTitleOf(t.goal_id) : ''), line: 0,
            cell: (t) => { if (!t.goal_id) return ctx.noGoal || 'No goal'; const l = DT.link(ctx.goalTitleOf(t.goal_id), () => ctx.openGoal?.(t.goal_id)); l.dataset.goalLink = String(t.goal_id); return l; } },
        team: { key: 'team', label: 'Team', sort: true, sortValue: (t) => (ctx.teamOf ? ctx.teamOf(t) : t.board || ''), line: 0, cell: (t) => (ctx.teamOf ? ctx.teamOf(t) : t.board || '') },
        priority: { key: 'priority', label: 'Priority', tone: 'tertiary', sort: true, sortValue: (t) => PRIORITY_RANK[String(t.priority || '').toLowerCase()] ?? 3, line: 2, when: (t) => String(t.priority || '').toLowerCase() === 'high', cell: (t) => priorityWord(t.priority) },
        updated: { key: 'updated', label: 'Updated', tone: 'tertiary', align: 'end', sort: 'date', sortValue: (t) => t.updated_at || t.created_at || '', line: 1, firstDir: 'desc', cell: (t) => DT.timeCell(t.updated_at || t.created_at) },
    };
    return keys.map(k => all[k]);
}
