/* Computers approved on Coral Hub that have not connected yet (#11463 F2, coral-hub's first-time-user walk). The hub's GET /api/servers/pending (owner session only) answers
 *   {pending: [{label, state: 'waiting' | 'expired', expires_at, requested_at}]}   newest first, at most 20, every row an approved code that was never collected
 * (no codes, hashes or ids). A newcomer who approved a computer and sees nothing, or "Connect your first computer" again, thinks the approval did nothing: this says what is going on. The label is
 * text the owner typed, so it is only ever set with textContent (never HTML). A hub that does not answer the route yet (an older one) is no pending list: nothing is shown. */
import { state } from './state.js';

export const PENDING_URL = '/api/servers/pending';
export const NEVER_CONNECTED = 'Never connected: start again';
export const NEVER_CONNECTS_HELP = 'If that computer never connects, the approval runs out after 10 minutes and nothing is added. Press Connect to Coral Hub on that computer again; it takes a few seconds.';
/** The three things to look at when a computer does not connect after it was approved. */
export const WAITING_CHECKS = [
    'Coral is running on that computer.',
    'That computer can reach this hub\'s address.',
    'There is still time left on the approval (see when it expires).',
];

const TIME_FIELDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const valid = p => !!p && typeof p.label === 'string' && p.label.length <= 200 && (p.state === 'waiting' || p.state === 'expired') && (p.expires_at === undefined || (typeof p.expires_at === 'string' && TIME_FIELDS.test(p.expires_at)));

export const pendingRows = () => (Array.isArray(state.hubPending) ? state.hubPending : []);
export const waitingRows = () => pendingRows().filter(p => p.state === 'waiting');
export const expiredRows = () => pendingRows().filter(p => p.state === 'expired');

/** HH:MM of an RFC 3339 time, in this browser's clock; '' for anything else. */
export function clock(iso) {
    const d = new Date(iso);
    if (typeof iso !== 'string' || Number.isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export const waitingText = p => `Waiting for ${p.label || 'a computer'} to connect` + (clock(p.expires_at) ? ` (expires ${clock(p.expires_at)})` : '');

let lastAsk = 0;
/** Read the pending list into state.hubPending (on the hub only, at most every 8 s unless `force`). Resolves true when the list changed. */
export async function refreshPending({ force = false, fetcher = (...a) => fetch(...a), now = Date.now } = {}) {
    if (state.cloud !== true) return false;
    if (!force && now() - lastAsk < 8000) return false;
    lastAsk = now();
    let rows = [];
    try {
        const r = await fetcher(PENDING_URL, { headers: { Accept: 'application/json' } });
        if (r.ok) { const d = await r.json(); rows = Array.isArray(d?.pending) ? d.pending.filter(valid).slice(0, 20) : []; }
    } catch { /* not answering: no list */ }
    const changed = JSON.stringify(rows) !== JSON.stringify(state.hubPending || []);
    state.hubPending = rows;
    return changed;
}

/** Fill a drawn pending card or list: one <strong> per waiting computer in each [data-pending-labels], with textContent (the name is text the owner typed). */
export function fillPendingLabels(root, rows = waitingRows()) {
    root.querySelectorAll('[data-pending-labels]').forEach(box => {
        box.replaceChildren(...rows.map(p => { const el = document.createElement('strong'); el.className = 'hub-pending-name'; el.textContent = waitingText(p); return el; }));
    });
}
