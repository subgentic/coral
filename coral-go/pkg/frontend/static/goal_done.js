/* "Goal #N looks done" (#11825): an active goal whose tasks are all done is ONE item of Needs you (it was a box on the goal screen). Close goal opens the goal's Close dialog set to Done; Not yet hides it until a
 * task is added; Ignore hides it for good, with Undo. What is hidden is kept on the machine in the goal_done_hidden setting, a JSON list of "<team>|<goal>|<tasks>" (Not yet, at the all-done total it was pressed at)
 * and "<team>|<goal>|*" (Ignore), so the Hub's phone push and every browser agree. This computer's goals only (the Operator's alone: a goal on another computer is closed there). */
import { state } from './state.js';

// goal_words.js's rule (readyToClose, allTasksOf), written out here: the Inbox tab's badge imports this file at start, and the goal words are not loaded until a goal is shown.
const tasksOf = r => ['active', 'blocked', 'queued', 'done'].reduce((n, k) => n + Math.max(0, Number((r || {})[k]) || 0), 0);
const openOf = r => tasksOf(r) - Math.max(0, Number((r || {}).done) || 0);
const readyToClose = g => String((g && g.state) || '').toLowerCase() === 'active' && tasksOf(g && g.rollup) > 0 && openOf(g && g.rollup) === 0;
const allTasksOf = tasksOf;

let counted = 0;
/** How many goal items Needs you holds, as the Inbox sidebar last worked it out: the tab's badge adds it to its count (the sidebar is loaded after the Inbox is first opened). */
export const goalDoneCount = () => counted;
export const setGoalDoneCount = n => { counted = n; };

export const SETTING = 'goal_done_hidden';
const MAX = 100;
const keyOf = (team, g) => `${team}|${g.id}|${allTasksOf(g.rollup)}`;
const starOf = (team, g) => `${team}|${g.id}|*`;

/** The saved list: strings only, the newest 100. */
export function hiddenList(settings = state.settings) {
    try { const v = JSON.parse(String((settings || {})[SETTING] || '[]')); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(-MAX) : []; } catch { return []; }
}

/** The goals that look done and are not hidden. teamOf(g) is the team's own id on this computer, or '' for a goal that is not on it. */
export function doneGoals(goals, teamOf, settings = state.settings) {
    const hidden = new Set(hiddenList(settings));
    return (goals || []).filter(g => { const team = teamOf(g); return team && readyToClose(g) && !hidden.has(keyOf(team, g)) && !hidden.has(starOf(team, g)); });
}

async function save(list) {
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [SETTING]: JSON.stringify(list.slice(-MAX)) }) });
    if (!r.ok) throw new Error(`could not save it (HTTP ${r.status})`);
    state.settings = { ...(state.settings || {}), [SETTING]: JSON.stringify(list.slice(-MAX)) };
}

/** Hides a goal's item: mode 'not-yet' (until a task is added) or 'ignore'. Resolves to a function that puts it back. */
export async function hideGoalDone(team, g, mode) {
    const entry = mode === 'ignore' ? starOf(team, g) : keyOf(team, g);
    await save([...hiddenList().filter(e => e !== entry), entry]);
    return () => save(hiddenList().filter(e => e !== entry));
}
