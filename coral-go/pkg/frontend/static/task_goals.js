/* A task names its goal (#7253): the board's goals for the Goal select, a goal's title for the Goal line and the chip on a Tasks row. The goals routes are the ones the Goals view reads (#7087). */
import { boardFetch, pathId } from './server_base.js';
import { toGoal, toGoalList } from './goals_adapter.js';
import { importOnce } from './import_once.js';
import { browserLocal } from './safe_storage.js';

const OPEN_STATES = 'proposed,active,blocked';
const ALL_STATES = 'proposed,active,blocked,done,dropped';

export const noGoalLabel = 'No goal';
export const chooseGoalLabel = 'Choose a goal';
export const requireGoalSentence = 'Every new task needs a goal, and a task cannot be moved to no goal.';

/** Every goal of the board in these states, following the route's cursor; ok is false when a read failed. */
async function readGoals(project, states) {
    const out = { goals: [], requireGoal: false, ok: false };
    try {
        let cursor = '';
        for (let n = 0; n < 20; n++) {
            const r = await boardFetch(project, `/goals?state=${states}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            if (!r.ok) return out;
            const json = await r.json(), page = toGoalList(json);
            out.goals = out.goals.concat(page.goals); out.requireGoal = page.requireGoal;
            cursor = json && !Array.isArray(json) && typeof json.next_cursor === 'string' ? json.next_cursor : '';
            if (!cursor) break;
        }
        out.ok = true;
    } catch { /* the select then offers only the empty choice */ }
    return out;
}

/** Whether the board requires a goal on every task: its settings say (the goals list does not). False when they cannot be read, as through Coral Hub. */
async function readRequireGoal(project) {
    try {
        const r = await boardFetch(project, '/settings');
        return r.ok ? Boolean((await r.json()).require_goal) : false;
    } catch { return false; }
}

/** The board's open goals (proposed, active, blocked) and whether it requires a goal. */
export async function readOpenGoals(project) {
    const [read, requireGoal] = await Promise.all([readGoals(project, OPEN_STATES), readRequireGoal(project)]);
    return { ...read, requireGoal };
}

/** One goal by number: null when it cannot be read. */
export async function readGoal(project, id) {
    try {
        const r = await boardFetch(project, `/goals/${pathId(id)}`);
        if (!r.ok) return null;
        const json = await r.json();
        return toGoal(json && json.goal ? json.goal : json);
    } catch { return null; }
}

/**
 * Fill a Goal select: the empty choice ("No goal", or "Choose a goal" when the board requires one), the open goals, and the task's current goal even
 * when it is closed (so Save does not unlink it by accident). Returns the select.
 */
export function fillGoalSelect(select, { goals, requireGoal, selectedId, current }) {
    select.replaceChildren();
    const none = document.createElement('option');
    none.value = ''; none.textContent = requireGoal ? chooseGoalLabel : noGoalLabel;
    select.append(none);
    const seen = new Set();
    const add = (g, suffix) => {
        if (!g || !g.id || seen.has(g.id)) return;
        seen.add(g.id);
        const o = document.createElement('option');
        o.value = String(g.id); o.textContent = g.title + (suffix || '');
        select.append(o);
    };
    for (const g of goals) add(g);
    if (current && current.id && !seen.has(current.id)) add(current, current.state ? ` (${current.state})` : '');
    select.value = selectedId && seen.has(Number(selectedId)) ? String(selectedId) : '';
    if (requireGoal) { select.required = true; select.setAttribute('aria-required', 'true'); } else { select.required = false; select.removeAttribute('aria-required'); } // a board that needs a goal says so to a screen reader (#7313)
    clearGoalInvalid(select);
    return select;
}

// Goal titles by board, for the chip on a Tasks row: read once a minute at most, from every state so a task of a closed goal still names it.
const titles = new Map(); // project -> { at, byId: Map }
const TITLES_MS = 60000;

/** The goal's title from the last read, or ''. */
export const goalTitle = (project, id) => (titles.get(project)?.byId.get(Number(id))) || '';

/** Read the board's goal titles when the last read is old; true when they changed. */
export async function refreshGoalTitles(project) {
    const have = titles.get(project);
    if (have && Date.now() - have.at < TITLES_MS) return false;
    const got = await readGoals(project, ALL_STATES);
    if (!got.ok) return false;
    const byId = new Map(got.goals.map(g => [g.id, g.title]));
    const before = have ? JSON.stringify([...have.byId]) : '';
    titles.set(project, { at: Date.now(), byId });
    return JSON.stringify([...byId]) !== before;
}

/** The Goal line of a task's detail: the goal's title on the button once it is read ("Goal #n" until then). */
export async function fillGoalLine(project, id) {
    const btn = document.getElementById('task-detail-goal-open');
    if (!btn || !project || !id) return;
    const goal = await readGoal(project, id);
    const now = document.getElementById('task-detail-goal-open');
    if (goal && goal.title && now && now.dataset.goalId === String(id)) { now.textContent = goal.title; now.setAttribute('aria-label', `Open the goal: ${goal.title}`); }
}

/** Show a goal on the Goals face of its board: the Messages | Goals choice is set to Goals, the board is selected, the goal opens. */
export async function openGoalOnBoard(project, id) {
    if (!project || !id) return;
    browserLocal.set('coral.board.face', 'goals');
    const board = await importOnce('./message_board.js');
    board.selectBoardProject(project);
    const view = await importOnce('./goals_view.js');
    view.openGoalWhenKnown(id);
}

/** A refusal beside the Goal select: the message in its own alert line, the select marked invalid and described by it; clearGoalInvalid undoes it. */
export function showGoalInvalid(select, line, message) {
    line.textContent = ''; line.hidden = false; line.textContent = message;
    select.setAttribute('aria-invalid', 'true'); select.setAttribute('aria-describedby', line.id); select.focus(); line.scrollIntoView({ block: 'nearest' }); // at large text the refusal under the select would sit behind the dialog's footer (#7313)
}
export function clearGoalInvalid(select) {
    select.removeAttribute('aria-invalid'); select.removeAttribute('aria-describedby');
    const line = select.closest('label')?.nextElementSibling;
    if (line && line.classList.contains('task-goal-error')) { line.hidden = true; line.textContent = ''; }
}
