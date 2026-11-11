/* One read of a file's version list (#15578): the version bar, the review bar's "a newer version" and the version list all ask GET /api/artifacts/<hex>/versions for the same file as the viewer opens.
 * A file opens with one request, not one per part (a 404 the Hub's operator sees is asked at most once per open, #13489):
 *  - a read in flight is shared by everyone who asks for the same file, computer and team;
 *  - the version bar's own read is always new and is remembered for REUSE_MS; the parts that only want to know ("is there a newer one", the list) pass { reuse: true } and take that answer when it is that fresh.
 * Each caller gets its own copy of the response, so each reads the body itself. A bar that asks again (a poll, a reload after an upload) always gets a new answer. */
import { fetchSkewed, VERSIONS_KEYS } from './query_skew.js';

const REUSE_MS = 5000;
const reading = new Map(), last = new Map();

const copy = p => p.then(r => ({ response: r.response.clone(), dropped: r.dropped }));

export function readVersions(server, hex, board, { reuse = false } = {}) {
    const key = `${server || ''}|${hex}|${board || ''}`;
    const old = last.get(key);
    if (reuse && old && Date.now() - old.at < REUSE_MS) return copy(old.p);
    let p = reading.get(key);
    if (!p) {
        p = fetchSkewed(server, `/api/artifacts/${hex}/versions`, board ? { board } : {}, { kind: 'versions', keys: VERSIONS_KEYS, retry: false });
        reading.set(key, p);
        const done = () => { if (reading.get(key) === p) reading.delete(key); };
        p.then(done, done);
        p.then(() => { last.set(key, { p, at: Date.now() }); if (last.size > 50) last.delete(last.keys().next().value); }, () => last.delete(key));
    }
    return copy(p);
}
