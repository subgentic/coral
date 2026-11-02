/* "Goal #N looks done" (#11825): an active goal whose tasks are all done is ONE item of Needs you (it was a box on the goal screen). Close goal opens the goal's Close dialog set to Done; Not yet hides it until a
 * task is added; Ignore hides it for good, with Undo. What is hidden is kept on the machine in the goal_done_hidden setting, a JSON list of "<team>|<goal>|<tasks>" (Not yet, at the all-done total it was pressed at)
 * and "<team>|<goal>|*" (Ignore), so the Hub's phone push and every browser agree. This computer's goals only (the Operator's alone: a goal on another computer is closed there). */
import { state } from './state.js';

// goal_words.js's rule (readyToClose, allTasksOf), written out here: the Inbox tab's badge imports this file at start, and the goal words are not loaded until a goal is shown.
const tasksOf = r => ['active', 'blocked', 'queued', 'done'].reduce((n, k) => n + Math.max(0, Number((r || {})[k]) || 0), 0);
const openOf = r => tasksOf(r) - Math.max(0, Number((r || {}).done) || 0);
const readyToClose = g => String((g && g.state) || '').toLowerCase() === 'active' && tasksOf(g && g.rollup) > 0 && openOf(g && g.rollup) === 0;
const allTasksOf = tasksOf;
/** Whether a goal looks done (an active goal whose tasks are all done): the goal's page offers Not yet for it, as its item in Needs you does (#12248). */
export const looksDone = readyToClose;

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

/** How long a goal whose tasks are all done waits after its latest task completion before it is the Operator's item (#12161): goal_done_quiet_minutes, 15 by default, as the server reads it. */
export function quietMs(settings = state.settings) {
    const raw = String((settings || {}).goal_done_quiet_minutes ?? '').trim(), n = Number(raw);
    return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 1440 ? n * 60000 : 15 * 60000;
}
/** When the quiet period of a goal that looks done is over, in ms since the epoch: its latest task completion (looks_done_at, #12081) plus the period; 0 when the server sent no completion time (an older one: not held back). */
export function quietEndsAt(g, settings = state.settings) {
    const t = Date.parse(g && g.looks_done_at);
    return Number.isFinite(t) ? t + quietMs(settings) : 0;
}

/** The goals that look done and are not hidden, once their quiet period is over. teamOf(g) is the team's own id on this computer, or '' for a goal that is not on it. */
export function doneGoals(goals, teamOf, settings = state.settings, now = Date.now()) {
    const hidden = new Set(hiddenList(settings));
    return (goals || []).filter(g => { const team = teamOf(g); return team && readyToClose(g) && now >= quietEndsAt(g, settings) && !hidden.has(keyOf(team, g)) && !hidden.has(starOf(team, g)); });
}

/** Milliseconds until the next goal that is all done and not hidden leaves its quiet period (so the page draws it then), or null when none is waiting. */
export function nextQuietEnd(goals, teamOf, settings = state.settings, now = Date.now()) {
    const hidden = new Set(hiddenList(settings));
    let next = null;
    for (const g of goals || []) {
        const team = teamOf(g), end = quietEndsAt(g, settings);
        if (!team || !readyToClose(g) || end <= now || hidden.has(keyOf(team, g)) || hidden.has(starOf(team, g))) continue;
        next = next === null ? end - now : Math.min(next, end - now);
    }
    return next;
}

async function save(list, setting = SETTING) {
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [setting]: JSON.stringify(list.slice(-MAX)) }) });
    if (!r.ok) throw new Error(`could not save it (HTTP ${r.status})`);
    state.settings = { ...(state.settings || {}), [setting]: JSON.stringify(list.slice(-MAX)) };
}

/* Opening a goal's item reads it (#11983, the Operator): it stays listed and stops counting, as an opened file does, so the Inbox number, the tab badge, the phone push and /api/needs-you say one number. It is kept in
 * goal_done_read as "<team>|<goal>|<tasks>|<updated_at>", the all-done total and the goal's last change it was opened at: a goal that gets another task done has a new total, and one that is reopened or edited a new last
 * change, so either way it is unread again. */
export const READ_SETTING = 'goal_done_read';
const readKeyOf = (team, g) => `${keyOf(team, g)}|${g.updated_at || g.updatedAt || ''}`; // the total and the goal's last change: a goal reopened or edited since is unread again (#12006)
export function readList(settings = state.settings) {
    try { const v = JSON.parse(String((settings || {})[READ_SETTING] || '[]')); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(-MAX) : []; } catch { return []; }
}
/** Whether the Operator has opened this goal's item at its present total. */
export const isGoalDoneRead = (team, g, settings = state.settings) => readList(settings).includes(readKeyOf(team, g));
/** Marks the goal's item read (nothing is written when it already is). */
export async function markGoalDoneRead(team, g) {
    if (isGoalDoneRead(team, g)) return;
    await save([...readList(), readKeyOf(team, g)], READ_SETTING);
}
/** Counts the goal's item again. */
export async function markGoalDoneUnread(team, g) {
    const entry = readKeyOf(team, g);
    if (!readList().includes(entry)) return;
    await save(readList().filter(e => e !== entry), READ_SETTING);
}

/** Hides a goal's item: mode 'not-yet' (until a task is added) or 'ignore'. Resolves to a function that puts it back. */
export async function hideGoalDone(team, g, mode) {
    const entry = mode === 'ignore' ? starOf(team, g) : keyOf(team, g);
    await save([...hiddenList().filter(e => e !== entry), entry]);
    return () => save(hiddenList().filter(e => e !== entry));
}
