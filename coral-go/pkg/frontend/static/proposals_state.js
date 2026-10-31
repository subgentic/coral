/* What agents asked to add to a team, and have not been decided (#11389): the list, read from GET /api/proposals, and the decisions. No page here, so the Inbox's badge can count them without loading the table:
 * like the review rows it reads only after the Inbox was first opened, then keeps itself current (at most one read in 20 seconds). The Operator's alone: a guest or a grantee is answered 403, and has no rows. */
import { serverFetch, LOCAL_SERVER } from './server_base.js';
import { browserLocal } from './safe_storage.js';
import { visibleName } from './artifact_names.js';

const DISMISSED_KEY = 'coral.proposals.dismissed.v1';
const dismissed = () => { try { return new Set(JSON.parse(browserLocal.get(DISMISSED_KEY) || '[]')); } catch { return new Set(); } };
let items = [], reading = null, activated = false, lastRead = 0;
const listeners = [];

/** The proposals on the list: pending ones, and the expired ones not yet dismissed here. */
export const proposalItems = () => items;
export const pendingProposals = () => items.filter(p => p.state === 'pending');
export function onProposalsChanged(fn) { listeners.push(fn); }
const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* one listener's failure is not the others' */ } } };

/** Reads the proposals again. Without `force` nothing is read before the Inbox was first opened, and not more than once in 20 seconds. A refusal is no rows; an error keeps what was shown. */
export function refreshProposals(force = false) {
    if (force) activated = true;
    if (!activated) return null;
    if (reading) return reading;
    if (!force && Date.now() - lastRead < 20000) return null;
    reading = (async () => {
        try {
            const r = await serverFetch(LOCAL_SERVER, '/api/proposals?state=pending,approving,expired');
            lastRead = Date.now();
            if (r.status === 403) items = [];
            else if (r.ok) {
                const hide = dismissed(), rows = (await r.json()).proposals || [];
                items = rows.filter(p => !(p.state === 'expired' && hide.has(`${p.board_id}:${p.id}`))).map(p => ({ ...p, rowKey: `proposal:${p.board_id}:${p.id}`, proposer: visibleName(p.proposer) || 'An agent' }));
            }
        } catch { /* keep the rows as they are */ }
        reading = null;
        changed();
    })();
    return reading;
}

/** Forgets an expired proposal in this browser (it stays on the machine, as expired). */
export function dismissExpired(p) {
    const hide = dismissed(); hide.add(`${p.board_id}:${p.id}`);
    try { browserLocal.set(DISMISSED_KEY, JSON.stringify([...hide].slice(-500))); } catch { /* the row comes back at the next read */ }
    items = items.filter(x => x.rowKey !== p.rowKey); changed();
}

const wordsOf = async (r, fallback) => { try { const j = await r.json(); return j.error || j.message || fallback; } catch { return fallback; } };

/** Approve (edits: the words changed) or reject (reason) a proposal. Resolves to { ok, text, created }: the words to show either way. */
export async function decide(p, action, body = {}) {
    try {
        const r = await serverFetch(LOCAL_SERVER, `/api/board/${encodeURIComponent(p.board_id)}/proposals/${p.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) { const text = await wordsOf(r, `could not ${action} it (${r.status})`); await refreshProposals(true); return { ok: false, text }; }
        const out = await r.json().catch(() => ({}));
        await refreshProposals(true);
        return { ok: true, created: out.created_id || 0, text: action === 'approve' ? `Approved: it is now ${p.kind === 'goal' ? 'goal' : 'task'}${out.created_id ? ` #${out.created_id}` : ''}.` : 'Rejected. The agent is told.' };
    } catch { return { ok: false, text: `Could not ${action} it: the connection failed.` }; }
}
