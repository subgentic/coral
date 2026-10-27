/* A task names its goal (#7253): the board's goals for the Goal select, a goal's title for the Goal line and the chip on a Tasks row. The goals routes are the ones the Goals view reads (#7087). */
import { boardFetch, pathId } from './server_base.js';
import { toGoal, toGoalList } from './goals_adapter.js';
import { importOnce } from './import_once.js';

const OPEN_STATES = 'proposed,active,blocked';
const ALL_STATES = 'proposed,active,blocked,done,dropped';

export const noGoalLabel = 'No goal';
export const chooseGoalLabel = 'Choose a goal';
export const requireGoalSentence = 'Every new task needs a goal, and a task cannot be moved to no goal.';

/** Every goal of the board in these states, following the route's cursor; ok is false when a read failed. */
async function readGoals(project, states) {
    const out = { goals: [], requireGoal: false, noGoalOpen: null, ok: false };
    try {
        let cursor = '';
        for (let n = 0; n < 20; n++) {
            const r = await boardFetch(project, `/goals?state=${states}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            if (!r.ok) return out;
            const json = await r.json(), page = toGoalList(json);
            out.goals = out.goals.concat(page.goals); out.requireGoal = page.requireGoal; out.noGoalOpen = page.noGoalOpen ?? out.noGoalOpen;
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

/** The goals the Tasks filter offers (#7782): every goal of the board with its task count (all its tasks: done, active, blocked and queued), the open ones (proposed, active, blocked) and the closed ones (done, dropped)
 *  apart, and how many open tasks serve none (null while the route does not say). ok is false when the read failed. */
export async function readGoalChoices(project) {
    const got = await readGoals(project, ALL_STATES);
    const tasksOf = g => g.rollup.done + g.rollup.active + g.rollup.blocked + g.rollup.queued;
    const row = g => ({ id: g.id, title: g.title || `Goal ${g.id}`, tasks: tasksOf(g) });
    const isOpen = g => OPEN_STATES.split(',').includes(g.state);
    return { ok: got.ok, open: got.goals.filter(isOpen).map(row), closed: got.goals.filter(g => !isOpen(g)).map(row), noGoalOpen: got.noGoalOpen };
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

/** Show a goal on its team's page: the Goals tab with that goal open, at its own address (/team/<team>/goals/<id>). Never the board's page: every goal link outside the team page comes here. */
export async function openGoalOnTeamPage(team, id) {
    if (!team || !id) return;
    window.switchNavTab?.('agents', { fromHistory: true }); // the team page lives under Agents; the page writes its own address
    const m = await importOnce('./team_page.js');
    await m.openTeamPage(team, { tab: 'goals', item: Number(id) });
    // a person chose the goal: the keyboard starts at its way back once the page has drawn it, not at its heading (no ring round plain words, #7404; the goals are read first when the page is new)
    for (let i = 0; i < 40; i++) {
        const heading = document.querySelector('#team-panel-goals #goals-detail-title'), back = document.querySelector('#team-panel-goals .goal-main .goals-back');
        if (heading && heading.textContent && back) { back.focus({ preventScroll: true }); return; }
        await new Promise(r => setTimeout(r, 50));
    }
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
