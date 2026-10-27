/* How often an idle poll asks again (#9101): a poll that finds nothing new waits longer each time (1 s, 1 s, 1 s, then 2, 4, 8, 10 s), and goes back to every second the moment something
 * changes or the person does something. A pure schedule, so the agent page's chat poll (live_history.js) and its test share it. */
export const QUICK_POLLS = 3;       // polls at the base rate before it slows
export const MAX_WAIT_FACTOR = 10;  // the longest wait, in base ticks

/** How many base ticks the poll after `idle` empty answers in a row waits: 1 for the first QUICK_POLLS, then 2, 4, 8, MAX_WAIT_FACTOR. */
export function ticksAfter(idle) {
    if (!(idle > QUICK_POLLS)) return 1;
    return Math.min(2 ** (idle - QUICK_POLLS), MAX_WAIT_FACTOR);
}

/** What puts a backed-off poll back to every second: the person acts (a key, a click, focus), the tab becomes visible again (a long hide left it at 10 s, #9124), the agent page comes back. */
export const WAKE_EVENTS = ['keydown', 'pointerdown', 'focus', 'visibilitychange', 'coral:agent-view-shown'];

/** The ticker of a backing-off poll: call tick() on every base tick; it runs step() (which resolves true when the poll found something new) only when its wait is over, and any of WAKE_EVENTS on `target` puts it back to
 *  every tick. stop() removes the listeners. */
export function backoffTicker(target, step) {
    let idle = 0, wait = 0;
    const wake = () => { idle = 0; wait = 0; };
    for (const e of WAKE_EVENTS) target.addEventListener(e, wake, true);
    return {
        async tick() {
            if (--wait > 0) return;
            const changed = await step();
            idle = changed ? 0 : idle + 1;
            wait = ticksAfter(idle);
        },
        stop() { for (const e of WAKE_EVENTS) target.removeEventListener(e, wake, true); },
    };
}
