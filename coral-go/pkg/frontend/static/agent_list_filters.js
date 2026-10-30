/* The agent list's filters and sort (#4744 stage 3, Search everywhere): what they are and how an agent is matched and ordered. Pure (no DOM, no imports), so it is tested on its own;
 * agent_list_bar.js draws the controls on the shared list bar (list_bar.js) and render.js applies them to the list the feed already holds (no request: the server has nothing to add).
 * The search text is the list's own box (agent_filter.js), so the filters here are State, Board and Machine, and the sort. */

import { defineFilters } from './filter_model.js';

export const STATES = ['needs_input', 'working', 'idle', 'asleep'];
export const STATE_LABEL = { needs_input: 'Needs input', working: 'Working', idle: 'Idle', asleep: 'Asleep' };
export const SORTS = ['default', 'name', 'recent', 'cost'];
export const SORT_LABEL = { default: 'List order', name: 'Name', recent: 'Recent activity', cost: 'Cost' };

// boardLabel and machineLabel turn a stored value into what the person reads in its chip
const filters = (boardLabel, machineLabel) => defineFilters({
    state: { type: 'choice', values: STATES, chip: v => `State: ${STATE_LABEL[v]}` },
    board: { type: 'text', max: 200, chip: v => `Board: ${boardLabel(v)}` },
    machine: { type: 'text', max: 200, chip: v => `Computer: ${machineLabel(v)}` },
    sort: { type: 'order', values: SORTS, default: 'default' },
});
const model = filters(v => v, v => v);
export const { EMPTY, clean, isFiltered } = model;

/** The filter's state for a session's state key (session_state.js): an agent that needs the person, one working, one asleep, and everything else awake is idle (idle, your turn, waiting on
 *  another agent or a task, a terminal to check, stuck). */
export function stateGroup(key) {
    if (key === 'needs_input') return 'needs_input';
    if (key === 'working') return 'working';
    if (key === 'sleeping') return 'asleep';
    return 'idle';
}

/** The model the shared list bar takes: the filters, their chips and how to remove one. boardLabel and machineLabel turn a stored value into what the person reads. */
export function makeModel({ boardLabel = v => v, machineLabel = v => v } = {}) {
    const { chips, without } = filters(boardLabel, machineLabel);
    return { EMPTY, clean, isFiltered, chips, without }; // without: a filter back to its empty value (the sort to the list's own order)
}

/** Whether an agent passes the filters. ctx: stateKey(s) (the session's state key), boardOf(s) (its board key or ''), machineOf(s) (its server id). */
export function matches(s, f, ctx) {
    if (f.state && stateGroup(ctx.stateKey(s)) !== f.state) return false;
    if (f.board && ctx.boardOf(s) !== f.board) return false;
    if (f.machine && ctx.machineOf(s) !== f.machine) return false;
    return true;
}

/** The comparator of a sort, or null for the list's own order. nameOf(s) is what the row shows as the agent's name. A missing number sorts last. */
export function comparator(sort, nameOf) {
    const name = s => String(nameOf(s) || '').toLowerCase();
    const num = (v, missing) => (typeof v === 'number' && Number.isFinite(v) ? v : missing);
    if (sort === 'name') return (a, b) => name(a).localeCompare(name(b));
    if (sort === 'recent') return (a, b) => num(a.staleness_seconds, Infinity) - num(b.staleness_seconds, Infinity) || name(a).localeCompare(name(b));
    if (sort === 'cost') return (a, b) => num(b.token_cost_usd, -1) - num(a.token_cost_usd, -1) || name(a).localeCompare(name(b));
    return null;
}
