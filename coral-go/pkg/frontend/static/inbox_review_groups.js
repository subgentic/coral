/* Goal dividers and pinned review ordering (#13888/#13889). Input order is the
 * selected sort; a divider is never an item, a selection, or an unread count. */
import { markHidden } from './visible_marks.js';
import { importOnce } from './import_once.js';
import { boardTeamKey } from './server_base.js';
const { waitingOnAgent } = await importOnce('./inbox_review_state.js');

/** What a row is about, whichever kind it is: a file for review carries its goal and task, a question to the Operator its own (the asker's declared or claimed ones, #14441). null for any other row. */
function aboutOf(row) {
    const r = row.review, a = row.operatorAsk;
    if (r) return { team: r.team, goalId: Number(r.goal_id) || 0, goalTitle: r.goal_title, taskId: Number(r.task_id) || 0, taskTitle: r.task_title };
    if (a) return { team: boardTeamKey(a.server, a.board), goalId: Number(a.goal_id) || 0, goalTitle: a.goal_title, taskId: Number(a.task_id) || 0, taskTitle: a.task_title };
    if (row.goal && row.goal.id && row.board_project) return { team: boardTeamKey(row.server, row.board_project), goalId: Number(row.goal.id) || 0, goalTitle: row.goal.title, taskId: Number(row.task && row.task.id) || 0, taskTitle: row.task && row.task.title }; // an agent waiting on a prompt or for input: the goal and task it works on (#14441)
    return null;
}
const goalKey = row => { const x = aboutOf(row); return x && x.goalId ? JSON.stringify([x.team, String(x.goalId)]) : 'no-goal'; };
const taskKey = row => { const x = aboutOf(row); return x && x.goalId && x.taskId ? JSON.stringify([x.team, String(x.goalId), 'task', String(x.taskId)]) : ''; };
const pinned = row => !!row.review?.starred;
/** Stable partitions: pins first, then source-qualified goals (inside a goal: what has no task, then each task's items together), No goal last, then non-review items. With grouping off only pins move. Never mutates input. */
export function arrangeReviewRows(rows, grouped) {
    const pins = rows.filter(pinned), waiting = rows.filter(r => !pinned(r) && r.review && waitingOnAgent(r.review)), rest = rows.filter(r => !pinned(r) && !(r.review && waitingOnAgent(r.review)));
    if (!grouped) return [...pins, ...rest, ...waiting];
    const goals = new Map(), others = [], noGoal = [];
    for (const row of rest) {
        const x = aboutOf(row);
        if (!x || !x.goalId) { (row.review ? noGoal : others).push(row); continue; }
        const key = goalKey(row);
        if (!goals.has(key)) goals.set(key, { loose: [], tasks: new Map() });
        const goal = goals.get(key), tk = taskKey(row);
        if (!tk) { goal.loose.push(row); continue; }
        if (!goal.tasks.has(tk)) goal.tasks.set(tk, []);
        goal.tasks.get(tk).push(row);
    }
    return [...pins, ...[...goals.values()].flatMap(g => [...g.loose, ...[...g.tasks.values()].flat()]), ...noGoal, ...waiting, ...others];
}
const cut = (text, n) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}\u2026` : t; };
/** One heading per contiguous group, including single documents. A task's items sit under a heading of their own, inside their goal's: its title, number, a Waiting on you chip while anything in it is unread, the count and its newest line; the heading opens and
 * shuts the items (#14441). Counts describe the filtered rows shown, never the whole goal or computer. `tasks` is { open(key, hasUnread) -> bool, toggle(key, open) }; without it a task's items are always shown. */
export function reviewGroupLookup(rows, grouped, isRead, sourceLabel, tasks = null) {
    const keyOf = r => { if (pinned(r)) return 'pinned'; if (r.review && waitingOnAgent(r.review)) return 'waiting-agent'; if (!grouped) return null; const x = aboutOf(r); if (!x || !x.goalId) return r.review ? 'no-goal' : 'other-items'; return taskKey(r) || goalKey(r); };
    const unreadOf = r => (r.review ? !isRead(r.review) : true); // a waiting agent or a question is waiting by being in the list
    const groups = new Map(), goals = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, { row, shown: 0, unread: 0, latest: row });
        const group = groups.get(key); group.shown++;
        if (unreadOf(row)) group.unread++;
        if (String(row.waiting_since || '') > String(group.latest.waiting_since || '')) group.latest = row;
        const x = grouped && aboutOf(row);
        if (x && x.goalId && !pinned(row) && !(row.review && waitingOnAgent(row.review))) { const gk = goalKey(row); if (!goals.has(gk)) goals.set(gk, { row, shown: 0, unread: 0 }); const g = goals.get(gk); g.shown++; if (unreadOf(row)) g.unread++; }
    }
    const goalLabel = (gk) => { const { row, shown, unread } = goals.get(gk), x = aboutOf(row), title = markHidden(String(x.goalTitle || ''), { strict: true }); return `Goal #${x.goalId}${title ? ` \u00b7 ${title}` : ''}\n${sourceLabel(x.team)} \u00b7 ${shown} shown \u00b7 ${unread} unread`; };
    const labels = new Map();
    for (const [key, { row, shown, unread, latest }] of groups) {
        const count = `${shown} shown \u00b7 ${unread} unread`;
        let entry;
        if (key === 'other-items') entry = { key, label: 'Other items' };
        else if (key === 'pinned') entry = { key, label: `Starred \u00b7 ${count}` };
        else if (key === 'waiting-agent') entry = { key, label: `Waiting on agent \u00b7 ${count}` };
        else if (key === 'no-goal') entry = { key, label: `No goal \u00b7 ${count}` };
        else if (taskKey(row) === key) {
            const x = aboutOf(row), title = markHidden(String(x.taskTitle || ''), { strict: true }), line = markHidden(cut(latest.review ? latest.review.name : latest.waiting_summary, 70), { strict: true }); // words an agent wrote: hidden characters written out, like the titles
            const open = tasks ? tasks.open(key, unread > 0) : true;
            entry = { key, label: `Task #${x.taskId}${title ? ` \u00b7 ${title}` : ''}\n${count}${line ? ` \u00b7 newest: ${line}` : ''}`, chip: unread > 0 ? 'Waiting on you' : '', level: 'task', open, ...(tasks ? { onToggle: () => tasks.toggle(key, !open) } : {}), parent: { key: goalKey(row), label: goalLabel(goalKey(row)) } };
        } else entry = { key, label: goalLabel(key) };
        labels.set(key, entry);
    }
    return row => labels.get(keyOf(row)) || null;
}
