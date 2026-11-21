import { importOnce } from './import_once.js';
import { invalidateArtifactReads } from './artifacts_feed.js';
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
export const _resetForTests = () => { refused.clear(); invalidateArtifactReads(); };

/** True for the connector's own refusal of a path or query (the Hub's coded 403); the body is read from a copy. */
export async function refusedByConnector(response) {
    if (response.status !== 403) return false;
    const body = await response.clone().json().catch(() => ({}));
    return body.code === 'path_not_allowed';
}

/** List fetching waits until a caller actually needs the list. */
export function fetchSkewed(...args) { return importOnce('./query_skew_read.js').then(m => m.fetchSkewed(...args)); }
