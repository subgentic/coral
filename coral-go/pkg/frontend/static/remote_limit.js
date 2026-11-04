/* A limit on what one page asks of one remote computer at once, and a retry of a read the Hub turned away (#13304).
 *
 * Coral Hub allows 8 requests in flight for one account and one computer and answers the rest at once with a 503 that is meant to be retried. A page that opens on a busy computer (the board status, the task
 * costs, the Needs you scan of every team) went over it: the refused reads were errors, the computer's pollers were paused for that 503 (overload.js) and Needs you drew nothing for 30 s. So, for a request to
 * /api/remote/<computer>/ (the only kind that crosses the Hub), installed under every other wrapper of window.fetch:
 *   - at most MAX_IN_FLIGHT of one computer's requests are in flight; the rest wait their turn (a request that is aborted while it waits never starts);
 *   - a read (GET or HEAD) answered 503 is asked again after the answer's Retry-After (1 s without one, at most 5 s, spread a little), at most RETRIES times, before anyone sees the 503; a write is never asked again;
 *   - a request keeps its slot for at most HOLD_MS (30 s): one that is still unanswered then goes on, but its slot is given to the next in line (#13351);
 *   - a computer's requests never wait for another computer's.
 * Nothing else changes: the same Response comes back, and a 503 that is still there after the retries is the answer (overload.js then pauses that computer's pollers as before). */
import { machineOf } from './overload.js';

export const MAX_IN_FLIGHT = 6;
export const RETRIES = 2;
const DEFAULT_WAIT_MS = 1000;
const MAX_WAIT_MS = 5000;
const HOLD_MS = 30000; // the longest a request may keep its slot (#13351): six that hang through the Hub must not block the computer's lane until a reload; the request goes on, only its slot is given back

/** Test seams. */
export const remoteLimitHooks = { sleep: ms => new Promise(r => setTimeout(r, ms)), rand: Math.random, holdMs: HOLD_MS }; // sleep-ok: the Hub asked for the wait

const lanes = new Map(); // computer -> { running, queue: [() => void] }

function pathOf(input) {
    try {
        const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input && input.url, location.href);
        return u.origin === location.origin ? u.pathname : '';
    } catch { return ''; }
}

const abortError = () => (typeof DOMException === 'function' ? new DOMException('The request was aborted.', 'AbortError') : Object.assign(new Error('The request was aborted.'), { name: 'AbortError' }));

function retryWaitMs(resp) {
    const s = Number(resp.headers && resp.headers.get && resp.headers.get('Retry-After'));
    const base = Number.isFinite(s) && s > 0 ? s * 1000 : DEFAULT_WAIT_MS;
    return Math.min(MAX_WAIT_MS, base * (1 + 0.25 * remoteLimitHooks.rand()));
}

function acquire(lane, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(abortError()); return; }
        const go = () => { lane.running++; resolve(); };
        if (lane.running < MAX_IN_FLIGHT) { go(); return; }
        const turn = () => { signal && signal.removeEventListener && signal.removeEventListener('abort', onAbort); go(); };
        const onAbort = () => { const i = lane.queue.indexOf(turn); if (i >= 0) lane.queue.splice(i, 1); reject(abortError()); };
        signal && signal.addEventListener && signal.addEventListener('abort', onAbort, { once: true });
        lane.queue.push(turn);
    });
}

function release(lane) {
    lane.running--;
    const next = lane.queue.shift();
    if (next) next();
}

/** Runs one request of the named computer under the limit; send makes the request. */
export async function limited(computer, method, signal, send) {
    let lane = lanes.get(computer);
    if (!lane) lanes.set(computer, lane = { running: 0, queue: [] });
    const read = method === 'GET' || method === 'HEAD';
    for (let attempt = 0; ; attempt++) {
        await acquire(lane, signal);
        let resp, freed = false;
        const free = () => { if (!freed) { freed = true; release(lane); } }; // a slot is given back once: by the answer, or by the hold running out, whichever comes first
        const hold = setTimeout(free, remoteLimitHooks.holdMs); // timer-ok: a one-shot cap on how long a slot is held, cleared when the request settles
        try { resp = await send(); } finally { clearTimeout(hold); free(); }
        if (!read || resp.status !== 503 || attempt >= RETRIES) return resp;
        await remoteLimitHooks.sleep(retryWaitMs(resp));
        if (signal && signal.aborted) throw abortError();
    }
}

let installed = false;
/** Wraps window.fetch once, under the wrappers installed after it. */
export function installRemoteLimit() {
    if (typeof window === 'undefined' || installed) return;
    installed = true;
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const computer = machineOf(pathOf(input));
        if (!computer) return orig(input, init);
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const signal = (init && init.signal) || (input && typeof input === 'object' && input.signal) || null;
        return limited(computer, method, signal, () => orig(input, init));
    };
}
