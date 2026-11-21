/* Query compatibility work is loaded on the first list read, rather than in
 * the startup bundle just to keep the badge's small refusal registry. */
import { serverFetch } from './server_base.js';
import { importOnce } from './import_once.js';
import { LIST_KEYS, knownOlder, markOlder, refusedByConnector } from './query_skew.js';
const without = (query, keys) => {
    const q = new URLSearchParams(query), dropped = keys.filter(k => q.has(k));
    for (const k of dropped) q.delete(k);
    return { q, dropped };
};

/** fetch of `path` on `server` with `query`; returns { response, dropped }, `dropped` naming the keys left out (empty when the read was sent whole). `kind` names the route for the memory, `keys` the ones an older
 *  computer may refuse. A computer already known to refuse them is sent the plain read at once. */
export async function fetchSkewed(server, path, query, { kind = path, keys = LIST_KEYS, retry = true, ...options } = {}) {
    const fetchRead = path === '/api/team-artifacts' ? (await importOnce('./artifact_reads.js')).readArtifacts : serverFetch;
    const at = (q) => { const s = q.toString(); return s ? `${path}?${s}` : path; };
    const whole = new URLSearchParams(query);
    if (!keys.some(k => whole.has(k))) return { response: await fetchRead(server, at(whole), options), dropped: [] };
    if (knownOlder(server, kind)) {
        const { q, dropped } = without(whole, keys);
        if (!retry) return { response: null, dropped };
        return { response: await fetchRead(server, at(q), options), dropped };
    }
    const response = await fetchRead(server, at(whole), options);
    if (!(await refusedByConnector(response))) return { response, dropped: [] };
    markOlder(server, kind);
    const { q, dropped } = without(whole, keys);
    if (!retry) return { response, dropped }; // a read with no honest plain form (the version bar): the refusal itself is the answer, and no second call is made
    return { response: await fetchRead(server, at(q), options), dropped };
}
