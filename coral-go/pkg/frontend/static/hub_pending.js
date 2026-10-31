/* Computers approved on Coral Hub that have not connected yet (#11463 F2, coral-hub's first-time-user walk). The hub's GET /api/servers/pending (owner session only) answers
 *   {pending: [{label, state: 'waiting' | 'expired', expires_at, requested_at}]}   newest first, at most 20, every row an approved code that was never collected (no codes, hashes or ids).
 * A newcomer who approved a computer and sees nothing, or "Connect your first computer" again, thinks the approval did nothing: pendingCard says what is going on. The label is text the owner typed:
 * only ever textContent, never HTML. A hub that does not answer the route yet is no pending list: nothing is shown. */
import { state } from './state.js';

const CHECKS = ['Coral is running on that computer.', 'That computer can reach this hub\'s address.', 'There is still time left on the approval (see when it expires).'];
export const pendingRows = () => (Array.isArray(state.hubPending) ? state.hubPending : []);
export const waitingRows = () => pendingRows().filter(p => p.state === 'waiting');
const expiredRows = () => pendingRows().filter(p => p.state === 'expired');
const clock = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5); }; // HH:MM, this browser's clock

let lastAsk = 0;
/** Read the pending list into state.hubPending (on the hub only, at most every 8 s). Resolves true when it changed. */
export async function refreshPending() {
    if (state.cloud !== true || Date.now() - lastAsk < 8000) return false;
    lastAsk = Date.now();
    let rows = [];
    try {
        const r = await fetch('/api/servers/pending', { headers: { Accept: 'application/json' } });
        if (r.ok) rows = ((await r.json())?.pending || []).filter(p => p && typeof p.label === 'string' && (p.state === 'waiting' || p.state === 'expired')).slice(0, 20);
    } catch { /* not answering: no list */ }
    const changed = JSON.stringify(rows) !== JSON.stringify(pendingRows());
    state.hubPending = rows;
    return changed;
}

/** What is going on, as a box: "Waiting for <name> to connect (expires HH:MM)" with the three things to check, "Never connected: start again" for one that ran out and what to do, and Add a computer. */
export function pendingCard() {
    const box = document.createElement('div'), put = (tag, text, cls = '') => { const e = document.createElement(tag); e.className = cls; e.textContent = text; box.append(e); return e; };
    box.className = 'hub-pending';
    for (const p of waitingRows()) put('strong', `Waiting for ${p.label} to connect${clock(p.expires_at) ? ` (expires ${clock(p.expires_at)})` : ''}`, 'hub-pending-name');
    if (waitingRows().length) { put('p', 'Check these:'); const ul = document.createElement('ul'); for (const c of CHECKS) { const li = document.createElement('li'); li.textContent = c; ul.append(li); } box.append(ul); }
    for (const p of expiredRows()) put('strong', `Never connected: start again (${p.label})`, 'hub-pending-name');
    if (expiredRows().length) put('p', 'The approval ran out after 10 minutes and nothing was added. Press Connect to Coral Hub on that computer again; it takes a few seconds.');
    const a = put('a', 'Add a computer', 'btn btn-primary btn-small'); a.href = '/machines/add';
    return box;
}
