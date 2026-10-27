/* One request for the same read, at load (#9111, the #9090 audit): the dashboard asks for the same few reads from several places in its first seconds (the hub status, the live
 * sessions, a board's status, a board's goals, the project list...: each was fetched two or three times on every screen). A GET of one of these routes that is asked again
 * while the first is in flight, or within a second after it answered, gets the first one's answer (each caller a clone of it, so each reads its own body). Only these named
 * reads, only a plain read (no abort signal, headers, cache mode, credentials, mode, referrer or redirect, and not a Request object: a caller that asks for a fresh read
 * gets one), and a write to Coral's /api forgets everything when it starts AND when it ends, and no read is shared while one is in flight, so a read after a change is never
 * the answer from before it. A failed answer is not kept. */
const SHARE_MS = 1000;
const SHARED = [
    /^\/api\/cloud\/status$/, /^\/api\/sessions\/live$/, /^\/api\/board\/projects$/, /^\/api\/board\/[^/]+\/status$/, /^\/api\/board\/[^/]+\/goals$/,
    /^\/api\/teams\/detail\/[^/]+\/(?:knowledge|distill-knowledge)$/, /^\/api\/workflows$/, /^\/api\/system\/(?:status|artifact-store)$/, /^\/api\/scheduled\/jobs$/,
];

let installed = false;

/** A read that says how it wants to be made (a header, a cache mode...) or comes as a Request object is its own request. */
const fresh = (input, init) => (input && typeof input === 'object' && !(input instanceof URL))
    || (init != null && ['headers', 'cache', 'credentials', 'mode', 'referrer', 'referrerPolicy', 'redirect', 'integrity', 'keepalive'].some(k => init[k] !== undefined));

function localApi(input) {
    try {
        const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input && input.url, location.href);
        return u.origin === location.origin && u.pathname.startsWith('/api/') ? u : null;
    } catch { return null; }
}

/** Wraps window.fetch once. `now` is for tests. */
export function installFetchShare(now = () => Date.now()) {
    if (typeof window === 'undefined' || installed) return;
    installed = true;
    const orig = window.fetch.bind(window);
    const entries = new Map(); // "path?query" -> { p: Promise<Response>, open: true while in flight, doneAt }
    let writing = 0; // writes to /api in flight
    window.fetch = function (input, init) {
        const u = localApi(input);
        if (!u) return orig(input, init);
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method !== 'GET') { // a write: nothing read before it, or while it ran, is the answer after it
            entries.clear(); writing++;
            return orig(input, init).finally(() => { writing--; entries.clear(); });
        }
        const signal = (init && init.signal) || (input && typeof input === 'object' && input.signal);
        if (writing > 0 || signal || fresh(input, init) || !SHARED.some(re => re.test(u.pathname))) return orig(input, init);
        const key = u.pathname + u.search;
        const hit = entries.get(key);
        if (hit && (hit.open || now() - hit.doneAt < SHARE_MS)) return hit.p.then(r => r.clone());
        for (const [k, e] of entries) if (!e.open && now() - e.doneAt >= SHARE_MS) entries.delete(k);
        const entry = { open: true, doneAt: 0, p: null };
        entry.p = orig(input, init).then(r => { entry.open = false; if (r.ok) entry.doneAt = now(); else if (entries.get(key) === entry) entries.delete(key); return r; }, e => { if (entries.get(key) === entry) entries.delete(key); throw e; });
        entries.set(key, entry);
        return entry.p.then(r => r.clone());
    };
}
