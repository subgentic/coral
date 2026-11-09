/* One GET /api/system/status for the callers that need it at startup (#3973). The startup check, the settings tier badge and the
 * tmux banner each fetched it on every page load: three requests for one answer. A successful answer is now shared for a few
 * seconds, so the callers that come right after the first reuse it; `fresh` asks again (the startup poll's retries, the tmux
 * "Check again" button), because those exist to see a change. Each caller gets its own Response clone to read. */
import { isCloud } from './server_base.js';
const SHARE_MS = 5000;
let _shared = null; // {at, promise}

export function fetchSystemStatus({ fresh = false } = {}) {
    if (isCloud()) return Promise.resolve(new Response('{"cloud":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })); // through the Hub the bare path answers a fixed stub (#14820): the same words, with no request; a computer's own status is read through /api/remote/<id>/ where one is meant
    const now = Date.now();
    if (!fresh && _shared && now - _shared.at < SHARE_MS) return _shared.promise.then(r => r.clone());
    const promise = fetch('/api/system/status', fresh ? { cache: 'no-store' } : undefined);
    const entry = { at: now, promise };
    _shared = entry;
    const drop = () => { if (_shared === entry) _shared = null; };
    promise.then(r => { if (!r.ok) drop(); }, drop);   // only a good answer is shared
    return promise.then(r => r.clone());
}
