/* The team's goals under its agents in the sidebar (#7453, UI/UX's one team page): each open goal with "1 of 4 done" and a chevron that shows its open tasks under it; a goal or a task opens its page on the team page.
 * Done tasks are in the goal's page, not here. The goals of a team on this computer are read when its card is first drawn and again when the goals feed (goals_feed.js) says the team's goals changed; a goal's tasks are read when
 * its chevron is opened. Everything is drawn as markup with escaped text (the agent list is built as a string, group_cards.js); the actions are in render.js. */
import { boardFetch, splitKey, LOCAL_SERVER } from './server_base.js';
import { toGoalList, toTaskPage } from './goals_adapter.js';
import { onGoalsSeq } from './goals_feed.js';
import { redrawLast } from './list_hooks.js';
import { escapeAttr, escapeHtml } from './utils.js';
import { allTasksOf, isOpenGoal, taskStatusWord } from './goal_words.js';

const boards = new Map(); // team key -> { goals: [{id, title, done, total}] | null, open: Set(goal id), tasks: Map(goal id -> [{id, title}] | null), reading: bool }
const OPEN_STATES = 'proposed,active,blocked';
const local = (team) => splitKey(team).server === LOCAL_SERVER;
const entry = (team) => { let b = boards.get(team); if (!b) { b = { goals: null, open: new Set(), tasks: new Map(), reading: false }; boards.set(team, b); } return b; };

async function readGoals(team) {
    const b = entry(team);
    if (b.reading) return;
    b.reading = true;
    try {
        const r = await boardFetch(team, `/goals?state=${OPEN_STATES}&limit=100`);
        if (!r.ok) throw new Error(String(r.status));
        const { goals } = toGoalList(await r.json());
        const next = goals.filter(isOpenGoal).map(g => ({ id: g.id, title: g.title, done: g.rollup.done, total: allTasksOf(g.rollup) }));
        const changed = JSON.stringify(next) !== JSON.stringify(b.goals);
        b.goals = next;
        for (const id of b.open) if (!next.some(g => g.id === id)) b.open.delete(id);
        if (changed) redrawLast();
    } catch { if (!b.goals) b.goals = []; } finally { b.reading = false; }
    for (const id of b.open) readTasks(team, id);
}

async function readTasks(team, id) {
    const b = entry(team);
    try {
        const r = await boardFetch(team, `/tasks?goal=${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(String(r.status));
        const rows = toTaskPage(await r.json()).rows.filter(t => taskStatusWord(t.state) !== 'Done').map(t => ({ id: t.id, title: t.title }));
        if (JSON.stringify(rows) !== JSON.stringify(b.tasks.get(id))) { b.tasks.set(id, rows); redrawLast(); }
    } catch { if (!b.tasks.has(id)) { b.tasks.set(id, []); redrawLast(); } }
}

/** Read a team's goals again (the team page does when it opens and every 30 s, the goals feed when they change). */
export function refreshGoalsTree(team) { if (local(team)) readGoals(team); }

/** The chevron of a goal: shows or hides its open tasks. */
export function toggleGoalTasks(team, id) {
    const b = entry(team);
    if (b.open.has(id)) b.open.delete(id); else { b.open.add(id); if (!b.tasks.has(id)) readTasks(team, id); }
    redrawLast();
}

const bareOf = (team) => { const k = splitKey(team); return k.server === LOCAL_SERVER ? k.name : ''; };
onGoalsSeq((board) => { for (const team of boards.keys()) if (bareOf(team) === board) readGoals(team); });

const CHEV = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

/** The goals of a team as list items for its card (empty text while they are not read, or when it has none). */
export function goalsTreeHtml(team) {
    if (!local(team)) return '';
    const b = entry(team);
    if (b.goals === null) { readGoals(team); return ''; }
    if (!b.goals.length) return '';
    let html = '<li class="sidebar-goals-head"><h3 class="sidebar-goals-title">Goals</h3></li>';
    for (const g of b.goals) {
        const open = b.open.has(g.id);
        const count = g.total ? `${g.done} of ${g.total} done` : 'No tasks';
        const chevClass = open ? 'sidebar-goal-chev open' : 'sidebar-goal-chev';
        const chevLabel = `${open ? 'Hide' : 'Show'} the tasks of ${g.title}`;
        const listLabel = `Open tasks of ${g.title}`;
        html += `<li class="sidebar-goal"><div class="sidebar-goal-row">`
            + `<button type="button" class="${escapeAttr(chevClass)}" data-on-click="goal-tree-toggle" data-board="${escapeAttr(team)}" data-goal-id="${Number(g.id)}" aria-expanded="${escapeAttr(String(open))}" aria-label="${escapeAttr(chevLabel)}">${CHEV}</button>`
            + `<button type="button" class="sidebar-goal-open" data-on-click="goal-tree-open" data-board="${escapeAttr(team)}" data-goal-id="${Number(g.id)}"><span class="sidebar-goal-title">${escapeHtml(g.title)}</span><span class="sidebar-goal-count">${escapeHtml(count)}</span></button></div>`;
        if (open) {
            const tasks = b.tasks.get(g.id);
            const items = tasks ? tasks.map(t => `<li><button type="button" class="sidebar-goal-task" data-on-click="goal-tree-task" data-board="${escapeAttr(team)}" data-task-id="${Number(t.id)}">${escapeHtml(t.title)}</button></li>`).join('') : '';
            if (tasks && tasks.length) html += `<ul class="sidebar-goal-tasks" aria-label="${escapeAttr(listLabel)}">${items}</ul>`;
            else if (tasks) html += '<p class="sidebar-goal-none">No open tasks</p>';
        }
        html += '</li>';
    }
    return html;
}
