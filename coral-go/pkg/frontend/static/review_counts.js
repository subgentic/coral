/* How many files wait for the Operator, without reading them (#13172, slice 2a). One small read per computer asks the computer's own list for the count: the files that wait by its Needs you rule (waiting=1), that its settings do not mute
 * (muted=0), one row for a file with all its versions (versions=newest), one row asked for (limit=1): the answer's total is the number. The tab's badge shows it from the first paint, without the Inbox having been opened and without reading
 * any page of any team. A computer that does not answer, or is too old to know these words (it refuses them), leaves the number unknown (null): the badge then shows what the full read has, as before. */
import { state } from './state.js';
import { serverFetch, isCloud } from './server_base.js';

export const COUNT_PATH = '/api/team-artifacts?tag=for%20review&waiting=1&muted=0&versions=newest&limit=1';
const EVERY_MS = 30000;
let unread = null, at = 0, pending = null;

/** The computers whose lists are counted: this one (not on the Hub's own page) and, on a hub, each online computer it manages. */
const sources = () => [...(isCloud() ? [] : ['local']), ...(state.hub ? (state.servers || []).filter(s => s.id !== 'local' && s.status === 'online').map(s => s.id) : [])];

/** The number of files waiting, or null while it is not known (not read yet, or a computer could not say). */
export const countedUnread = () => unread;

/** Reads the counts (at most once in 30 s, and one read in flight); resolves to true when the number changed. */
export function refreshCounts(force = false) {
    if (pending) return pending;
    if (!force && at && Date.now() - at < EVERY_MS) return Promise.resolve(false);
    const list = sources();
    if (!list.length) { const was = unread; unread = null; return Promise.resolve(was !== null); }
    at = Date.now();
    pending = (async () => {
        let total = 0;
        try {
            await Promise.all(list.map(async id => {
                const r = await serverFetch(id, COUNT_PATH);
                if (!r.ok) throw new Error('count refused');
                const n = Number((await r.json()).total);
                if (!Number.isFinite(n) || n < 0) throw new Error('count unreadable');
                total += n;
            }));
        } catch { total = null; }
        const changed = total !== unread;
        unread = total;
        return changed;
    })().finally(() => { pending = null; });
    return pending;
}
