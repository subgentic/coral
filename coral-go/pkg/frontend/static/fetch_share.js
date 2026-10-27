/* One request for the same read, at load (#9111, the #9090 audit): the dashboard asks for the same few reads from several places in its first seconds (the hub status, the live
 * sessions, a board's status, a board's goals, the project list...: each was fetched two or three times on every screen). A GET of one of these routes that is asked again
 * while the first is in flight, or within a second after it answered, gets the first one's answer (each caller a clone of it, so each reads its own body). Only these named
 * reads, only without an abort signal, and any write to Coral's /api forgets everything, so a read after a change is never the answer from before it. A failed answer is
 * not kept. */
const SHARE_MS = 1000;
const SHARED = [
    /^\/api\/cloud\/status$/, /^\/api\/sessions\/live$/, /^\/api\/board\/projects$/, /^\/api\/board\/[^/]+\/status$/, /^\/api\/board\/[^/]+\/goals$/,
    /^\/api\/teams\/detail\/[^/]+\/(?:knowledge|distill-knowledge)$/, /^\/api\/workflows$/, /^\/api\/system\/(?:status|artifact-store)$/, /^\/api\/scheduled\/jobs$/,
];

let installed = false;

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
    window.fetch = function (input, init) {
        const u = localApi(input);
        if (!u) return orig(input, init);
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method !== 'GET') { entries.clear(); return orig(input, init); } // a write: nothing read before it is the answer after it
        const signal = (init && init.signal) || (input && typeof input === 'object' && input.signal);
        if (signal || (init && init.headers) || !SHARED.some(re => re.test(u.pathname))) return orig(input, init);
        const key = u.pathname + u.search;
        const hit = entries.get(key);
        if (hit && (hit.open || now() - hit.doneAt < SHARE_MS)) return hit.p.then(r => r.clone());
        for (const [k, e] of entries) if (!e.open && now() - e.doneAt >= SHARE_MS) entries.delete(k);
        const entry = { open: true, doneAt: 0, p: null };
        entry.p = orig(input, init).then(r => { entry.open = false; if (r.ok) entry.doneAt = now(); else entries.delete(key); return r; }, e => { entries.delete(key); throw e; });
        entries.set(key, entry);
        return entry.p.then(r => r.clone());
    };
}
