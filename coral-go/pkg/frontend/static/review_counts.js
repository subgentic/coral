/* Per-computer attention totals, independent of which review pages are loaded.
 * Unknown and partial sources never become an authoritative zero. */
import { state } from './state.js';
import { serverFetch, isCloud } from './server_base.js';

export const COUNT_PATH = '/api/team-artifacts?tag=for%20review&waiting=1&muted=0&versions=newest&limit=1';
const EVERY_MS = 30000;
let unread = null, summary = null, at = 0, pending = null, lastSources = '', refreshAgain = false;
const sources = () => [...new Set([...(isCloud() ? [] : ['local']), ...(state.hub ? (state.servers || []).filter(s => s.id && s.id !== 'local' && s.status === 'online').map(s => s.id) : [])])];
export const countedUnread = () => unread;
export const countSummary = () => summary;
export function refreshCounts(force = false) {
    const list = sources(), key = JSON.stringify(list);
    if (pending) { if (force) refreshAgain = true; return pending; }
    if (!force && key === lastSources && at && Date.now() - at < EVERY_MS) return Promise.resolve(false);
    lastSources = key; at = Date.now();
    pending = (async () => {
        const replies = await Promise.all(list.map(async server => {
            try {
                const response = await serverFetch(server, COUNT_PATH), data = await response.json();
                if (response.status === 403 && (data.code === 'owner_only' || data.error === 'owner_only')) return { server, total: 0, ownerOnly: true };
                if (!response.ok || data.partial || data.truncated || data.failed_boards?.length || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('count unavailable');
                return { server, total: data.total };
            } catch { return { server, total: null }; }
        }));
        // A response for a removed computer cannot certify the new source set.
        if (JSON.stringify(sources()) !== key) { at = 0; unread = null; summary = null; return true; }
        const next = { sources: replies, complete: list.length > 0 && replies.every(r => r.total !== null),
            knownTotal: replies.reduce((n, r) => n + (r.total || 0), 0) };
        const changed = JSON.stringify(next) !== JSON.stringify(summary);
        summary = next; unread = next.complete ? next.knownTotal : null;
        return changed;
    })().then(async changed => {
        pending = null;
        if (refreshAgain) { refreshAgain = false; return (await refreshCounts(true)) || changed; }
        return changed;
    });
    return pending;
}
