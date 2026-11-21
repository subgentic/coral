/* Inbox lists use the same artifact query from badges and several tabs. Keep one
 * in flight and a five-second answer, scoped to the computer and its access.
 * Revisions, reconnects and local artifact writes discard every saved answer. */
import { serverFetch } from './server_base.js';
import { state } from './state.js';
import { artifactReadEpoch } from './artifacts_feed.js';
const reads = new Map(), TTL = 5000;
let writing = 0;
// Do not reuse a response across an API mutation. Telemetry has no data effect.
// UI review mutations also move the epoch explicitly (including stub transports).
if (typeof window !== 'undefined' && typeof window.fetch === 'function' && window.__coralNoFetchShare !== true) {
const transport = window.fetch.bind(window);
window.fetch = function (input, init) {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    let mutation = false;
    if (method !== 'GET' && method !== 'HEAD') try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        mutation = url.origin === location.origin && url.pathname.startsWith('/api/') && !url.pathname.endsWith('/api/tracking/event');
    } catch { /* a non-API request is not an artifact mutation */ }
    if (!mutation) return transport(input, init);
    reads.clear(); writing++;
    return transport(input, init).finally(() => { writing--; reads.clear(); });
};
}
const aborted = signal => signal.reason || new DOMException('The read was canceled.', 'AbortError');
function caller(promise, signal) {
    if (!signal) return promise.then(r => r.clone());
    return new Promise((resolve, reject) => {
        const stop = () => { signal.removeEventListener('abort', stop); reject(aborted(signal)); };
        signal.addEventListener('abort', stop, { once: true });
        promise.then(r => { signal.removeEventListener('abort', stop); if (!signal.aborted) resolve(r.clone()); }, error => { signal.removeEventListener('abort', stop); if (!signal.aborted) reject(error); });
        if (signal.aborted) stop();
    });
}
export function readArtifacts(server, path, options = {}) {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function' || typeof location === 'undefined' || window.__coralNoFetchShare === true) return serverFetch(server, path, options);
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(aborted(signal));
    // A caller with explicit freshness, credentials or headers owns that read.
    if (writing || Object.keys(options).some(k => k !== 'signal')) { reads.clear(); return serverFetch(server, path, options); }
    const source = (state.servers || []).find(s => s.id === server);
    const scope = source ? [source.url, source.api_key, source.status, source.access_mode, source.effective_mode, source.local_mode, source.owner] : [];
    const url = new URL(path, location.origin); url.searchParams.sort();
    const epoch = artifactReadEpoch();
    const key = JSON.stringify([server || 'local', scope, epoch, url.pathname, url.search]);
    const old = reads.get(key);
    if (old && (old.open || Date.now() - old.at < TTL)) return caller(old.promise, signal);
    for (const [k, entry] of reads) if (!entry.open && (entry.epoch !== epoch || Date.now() - entry.at >= TTL || reads.size >= 64)) reads.delete(k);
    const entry = { open: true, at: 0, epoch, promise: null };
    // One consumer canceling a stale tab must not cancel another consumer's
    // identical read. The shared transport still has a bounded lifetime.
    entry.promise = serverFetch(server, path, { signal: AbortSignal.timeout(15000) }).then(async r => {
        let valid = false;
        if (r.ok) try { valid = Array.isArray((await r.clone().json()).artifacts); } catch { /* a malformed successful answer is not reusable */ }
        entry.open = false; entry.at = Date.now();
        if (!valid && reads.get(key) === entry) reads.delete(key);
        return r;
    }, error => { if (reads.get(key) === entry) reads.delete(key); throw error; });
    reads.set(key, entry);
    return caller(entry.promise, signal);
}
