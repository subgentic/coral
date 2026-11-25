/* Private state for one exact document version (#21185). Close on context change. */
import { importOnce } from './import_once.js';
const api = await importOnce('./artifact_review_drafts_api.js');
import { browserSession } from './safe_storage.js';
import { boardTeamKey } from './server_base.js';
import { storeKey } from './local_store.js';
export function createDraftReview({ hex, server, board, changed }) {
    let active = true, generation = 0, data = null, pending = null, busy = false;
    const pendingKey = storeKey('coral-review-send:' + JSON.stringify([server || '', board || '', hex]));
    try { const saved = JSON.parse(browserSession.get(pendingKey) || 'null'); if (saved && typeof saved.request_id === 'string' && Number.isInteger(saved.revision)) pending = saved; } catch { /* malformed local state is not a request */ }
    const keepPending = () => { if (pending) browserSession.set(pendingKey, JSON.stringify(pending)); else browserSession.remove(pendingKey); };
    const update = () => { if (active) changed?.({ data, busy, pending }); };
    async function refresh() {
        const current = ++generation;
        const result = await api.readDrafts(hex, server, board);
        if (!active || current !== generation) return null;
        data = result; update(); return data;
    }
    async function mutate(fn) {
        if (!active || busy) throw new Error('Another review action is still running.');
        busy = true; update();
        try { await fn(); if (active) await refresh(); }
        finally { busy = false; update(); }
    }
    const requireWrite = () => {
        if (!data?.drafts_supported || !data.can_write) throw new Error('Draft comments cannot be changed here.');
        if (pending) throw new Error('Check the pending send before changing these drafts.');
    };
    return {
        refresh,
        snapshot: () => ({ data, busy, pending }),
        create: draft => { requireWrite(); return mutate(() => api.createDraft(hex, server, board, draft)); },
        edit: (id, draft) => { requireWrite(); return mutate(() => api.editDraft(hex, server, board, id, draft, data.revision)); },
        remove: id => { requireWrite(); return mutate(() => api.deleteDraft(hex, server, board, id, data.revision)); },
        async send() {
            if (!active || busy) throw new Error('Another review action is still running.');
            if (browserSession.get(storeKey('coral-review-decision:' + JSON.stringify([boardTeamKey(server, board), hex])))) throw new Error('A review decision is awaiting delivery. Retry that decision before sending comments separately.');
            if (!pending && !data?.can_send) throw new Error('Sending review comments is not available here. Your drafts stay saved.');
            if (!pending) pending = { request_id: crypto.randomUUID(), revision: data.revision };
            keepPending();
            let outcome;
            await mutate(async () => {
                try { outcome = await api.sendDrafts(hex, server, board, pending); }
                catch (error) {
                    if (api.reviewRefused(error.code)) { pending = null; keepPending(); try { await refresh(); } catch { /* preserve the original refusal */ } }
                    throw error;
                }
                if (!['sent', 'queued'].includes(outcome.status)) throw new Error('Delivery is not confirmed. Check the pending send before retrying.');
                pending = null; keepPending();
            });
            return outcome;
        },
        async checkSend() {
            if (!pending) return null;
            const request = pending;
            const outcome = await api.sendDrafts(hex, server, board, request);
            if (!active || pending !== request) return null;
            if (['sent', 'queued'].includes(outcome.status)) { pending = null; keepPending(); await refresh(); }
            update(); return outcome;
        },
        close() { active = false; generation++; },
    };
}
