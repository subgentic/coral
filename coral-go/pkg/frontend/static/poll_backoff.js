/* How often an idle poll asks again (#9101): a poll that finds nothing new waits longer each time (1 s, 1 s, 1 s, then 2, 4, 8, 10 s), and goes back to every second the moment something
 * changes or the person does something. A pure schedule, so the agent page's chat poll (live_history.js) and its test share it. */
export const QUICK_POLLS = 3;       // polls at the base rate before it slows
export const MAX_WAIT_FACTOR = 10;  // the longest wait, in base ticks

/** How many base ticks the poll after `idle` empty answers in a row waits: 1 for the first QUICK_POLLS, then 2, 4, 8, MAX_WAIT_FACTOR. */
export function ticksAfter(idle) {
    if (!(idle > QUICK_POLLS)) return 1;
    return Math.min(2 ** (idle - QUICK_POLLS), MAX_WAIT_FACTOR);
}
