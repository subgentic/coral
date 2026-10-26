/* The one task row (#7737): the team page's Tasks tab, the Inbox's Tasks group and a goal's task column draw a task with these pieces and no others, so the same task reads the same everywhere.
 * UI/UX's row: the state chip is the one coloured thing, the id is tertiary 12/400 before the title (14/600, cut with an ellipsis), then who, the priority as a word, and when it was last updated.
 *   A table (a desktop's Tasks tab and Inbox group): columns picked from COLUMN_HEADS, in the order given.
 *   A column (the goal page, and every list on a phone): two lines in a 44 px row, the id and title, then the chip, who and the priority when it is High.
 * A task is the board's own record (status, review_requested, assigned_to, worked_by, completed_by, goal_id, priority, created_at, updated_at, board). Everything is built with the DOM and textContent: titles and names are
 * written by agents.
 *   taskList(tasks, { label, columns, phone, ctx })  -> a table, or on a phone the column
 *   ctx: { openTask(task), openGoal(goalId), goalTitleOf(goalId), current: key, noGoal: 'No goal', teamOf(task) }
 */
import { whenText } from './when_text.js';
import { importOnce } from './import_once.js';
import { taskStatusWord, statusClass } from './goal_words.js';
const { teamTable, rowButton, stateChip, el } = await importOnce('./team_table.js'); // lazy: its failure is retried

export const COLUMN_HEADS = { state: 'State', task: 'Task', who: 'Assigned to', goal: 'Goal', team: 'Team', priority: 'Priority', when: 'Updated' };

export const taskKey = (t) => `t${t.id}`;
export const taskWord = (t) => taskStatusWord(t.status, t.review_requested);
/** The one chip: the same word and the same dot wherever a task is drawn. */
export const taskChip = (t) => { const w = taskWord(t); return stateChip(w, statusClass(w)); };
const isDone = (t) => t.status === 'completed';
/** Who did the work (the server's worked_by: the author of a reviewed task, not the orchestrator it was handed to); an older server has no worked_by: who completed a done task, else its assignee. */
export const doerOf = (t) => t.worked_by || (isDone(t) ? t.completed_by : '') || t.assigned_to;
export const whoText = (t) => { const w = doerOf(t); return isDone(t) ? (w ? `Done by ${w}` : 'Done') : (w || 'Nobody yet'); };
export const priorityWord = (p) => { const s = String(p || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : ''; };
export const updatedText = (t) => whenText(t.updated_at || t.created_at);

const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

/** The Task cell of a table: the id, then the title as the row's one real button. */
function titleCell(t, ctx) {
    const cell = el('span', 'task-title-cell');
    const b = rowButton(t.title, `Open task #${t.id}: ${t.title}`); b.dataset.taskId = String(t.id);
    cell.append(el('span', 'task-id', `#${t.id}`), b);
    return cell;
}

function goalCell(t, ctx) {
    if (!t.goal_id) return el('span', 'team-muted', ctx.noGoal || 'No goal');
    const link = button('team-link', ctx.goalTitleOf ? ctx.goalTitleOf(t.goal_id) : `Goal ${t.goal_id}`, () => ctx.openGoal?.(t.goal_id));
    link.dataset.goalLink = String(t.goal_id);
    return link;
}

const CELLS = {
    state: (t) => taskChip(t),
    task: (t, ctx) => titleCell(t, ctx),
    who: (t) => whoText(t),
    goal: (t, ctx) => goalCell(t, ctx),
    team: (t, ctx) => (ctx.teamOf ? ctx.teamOf(t) : t.board || ''),
    priority: (t) => priorityWord(t.priority),
    when: (t) => { const s = el('span', 'task-when', updatedText(t)); const at = t.updated_at || t.created_at; if (at) s.title = String(at); return s; },
};

export function taskTable(tasks, { label, columns, ctx = {} }) {
    return teamTable({
        label, columns: columns.map(c => COLUMN_HEADS[c]), className: 'task-table',
        rows: tasks.map(t => ({ key: taskKey(t), current: ctx.current === taskKey(t), open: () => ctx.openTask?.(t), cells: columns.map(c => CELLS[c](t, ctx)) })),
    });
}

/** A task as two lines in a 44 px row: line 1 the id and title, line 2 the chip, who and the priority when it is High. */
export function taskColumnRow(t, ctx = {}) {
    const li = el('li', 'task-col-row');
    const b = el('button', 'task-col-btn'); b.type = 'button'; b.dataset.taskId = String(t.id);
    b.setAttribute('aria-label', `Open task #${t.id}: ${t.title}, ${taskWord(t)}`);
    if (ctx.current === taskKey(t)) b.setAttribute('aria-current', 'true');
    const line1 = el('span', 'task-col-line1'); line1.append(el('span', 'task-id', `#${t.id}`), el('span', 'task-col-title', t.title));
    const line2 = el('span', 'task-col-line2'); line2.append(taskChip(t), el('span', 'task-col-who', whoText(t)));
    if (String(t.priority || '').toLowerCase() === 'high') line2.append(el('span', 'task-col-priority', 'High'));
    b.append(line1, line2);
    b.addEventListener('click', () => ctx.openTask?.(t));
    li.append(b);
    return li;
}

export function taskColumn(tasks, { label, ctx = {} }) {
    const ul = el('ul', 'task-col-list'); ul.setAttribute('aria-label', label);
    for (const t of tasks) ul.append(taskColumnRow(t, ctx));
    return ul;
}

/** A table on a desktop, the column on a phone (the one phone layout). */
export function taskList(tasks, { label, columns, phone = false, ctx = {} }) {
    return phone ? taskColumn(tasks, { label, ctx }) : taskTable(tasks, { label, columns, ctx });
}
