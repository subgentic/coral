import { serverFetch } from './server_base.js';
/* A newer shell on an older computer (#14317). A Hub serves one shell to computers on different releases, and a computer's own connector refuses any query key its release does not list (pkg/tunnel/routes_query.go:
 * queryOK); through a Hub that refusal reaches the shell as HTTP 403 {error: 'path not allowed', code: 'path_not_allowed'} (pkg/hubproxy/handler.go). A read that sends a key an older computer does not know is asked
 * again once without those keys, and that computer is remembered, so its next reads are sent plain and cost one call, not two. Nothing here changes a 403 that is anything else (owner_only, local_mode): only
 * path_not_allowed on a request that carried one of the keys named for it. */

/** The keys v2.0.59 added to each route; v2.0.58's table does not list them (query tables: GET /api/team-artifacts and GET /api/artifacts/{}/versions). */
export const LIST_KEYS = ['digest', 'facets', 'muted', 'starred_first', 'waiting'];
export const VERSIONS_KEYS = ['board'];

const REMEMBER_MS = 10 * 60 * 1000; // an upgraded computer is asked with the keys again after this: one refused call, then it is accepted
const refused = new Map(); // `${server} ${kind}` -> when that computer refused

export const LIST_KIND = '/api/team-artifacts';
const slot = (server, kind) => `${server || 'local'} ${kind}`;
/** A read that cannot be sent plain (the Inbox badge count: its total is only right with waiting and muted) tells the others that this computer refused. */
export const markOlder = (server, kind = LIST_KIND) => { refused.set(slot(server, kind), Date.now()); };
export function knownOlder(server, kind, now = Date.now()) {
    const at = refused.get(slot(server, kind));
    if (at === undefined) return false;
    if (now - at > REMEMBER_MS) { refused.delete(slot(server, kind)); return false; }
    return true;
}
/** For a test: forget every computer. */
export const _resetForTests = () => refused.clear();

/** True for the connector's own refusal of a path or query (the Hub's coded 403); the body is read from a copy. */
export async function refusedByConnector(response) {
    if (response.status !== 403) return false;
    const body = await response.clone().json().catch(() => ({}));
    return body.code === 'path_not_allowed';
}

const without = (query, keys) => {
    const q = new URLSearchParams(query), dropped = keys.filter(k => q.has(k));
    for (const k of dropped) q.delete(k);
    return { q, dropped };
};

/** fetch of `path` on `server` with `query`; returns { response, dropped }, `dropped` naming the keys left out (empty when the read was sent whole). `kind` names the route for the memory, `keys` the ones an older
 *  computer may refuse. A computer already known to refuse them is sent the plain read at once. */
export async function fetchSkewed(server, path, query, { kind = path, keys = LIST_KEYS, ...options } = {}) {
    const at = (q) => { const s = q.toString(); return s ? `${path}?${s}` : path; };
    const whole = new URLSearchParams(query);
    if (!keys.some(k => whole.has(k))) return { response: await serverFetch(server, at(whole), options), dropped: [] };
    if (knownOlder(server, kind)) {
        const { q, dropped } = without(whole, keys);
        return { response: await serverFetch(server, at(q), options), dropped };
    }
    const response = await serverFetch(server, at(whole), options);
    if (!(await refusedByConnector(response))) return { response, dropped: [] };
    markOlder(server, kind);
    const { q, dropped } = without(whole, keys);
    return { response: await serverFetch(server, at(q), options), dropped };
}
