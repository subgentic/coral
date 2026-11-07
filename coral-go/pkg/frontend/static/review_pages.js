/* One loaded review window. The caller owns protected reads, row identity and
 * attention policy. Importing this module reads nothing. More is always explicit;
 * refresh rereads only pages the person has already loaded, publishing atomically. */
export function createReviewPages({ read, key, changed = () => {} }) {
    if (typeof read !== 'function' || typeof key !== 'function') throw new TypeError('Review pages need a reader and a row key.');
    let generation = 0, query = '', sources = new Map();
    const make = server => ({ server, rows: new Map(), loaded: false, pending: null, abort: null,
        total: null, attentionTotal: null, tags: null, facets: null, cursor: '', more: false, error: '', pages: 0, ownerOnly: false, truncated: false, freshness: null });
    const statusOf = s => ({ server: s.server, loadedCount: s.rows.size, total: s.total, attentionTotal: s.attentionTotal, tag_counts: s.tags, facets: s.facets,
        loaded: s.loaded, loading: !!s.pending, has_more: s.more, next_cursor: s.cursor, error: s.error, ownerOnly: s.ownerOnly, truncated: s.truncated });
    const status = () => [...sources.values()].map(statusOf);
    const snapshot = () => [...sources.values()].map(s => ({ ...statusOf(s), artifacts: [...s.rows.values()] }));
    const current = (s, at) => generation === at && sources.get(s.server) === s;
    const validSources = servers => {
        if (!Array.isArray(servers) || servers.some(s => typeof s !== 'string' || !s)) throw new TypeError('Each review source must name its computer.');
        return [...new Set(servers)];
    };
    function setSources(servers) {
        const wanted = validSources(servers), next = new Map();
        for (const server of wanted) next.set(server, sources.get(server) || make(server));
        for (const [server, s] of sources) if (!next.has(server)) s.abort?.abort();
        sources = next;
    }
    function invalidate() {
        generation++;
        for (const s of sources.values()) { s.abort?.abort(); s.pending = null; s.abort = null; }
    }
    function reset(servers, nextQuery = '') {
        if (typeof nextQuery !== 'string') throw new TypeError('The review query must be serialized.');
        validSources(servers); invalidate(); query = nextQuery; sources = new Map(); setSources(servers); changed();
    }
    function fetchPage(s, append, retain = false, unchanged = null) {
        if (s.pending) return s.pending;
        const at = generation, requestedQuery = query, abort = s.abort = new AbortController();
        const depth = retain ? Math.max(1, s.pages) : 1;
        const hadError = !!s.error;
        s.error = '';
        s.pending = Promise.resolve().then(async () => {
            if (!current(s, at)) return;
            if (unchanged && s.loaded && !hadError && !s.truncated && s.freshness && await unchanged(s.server, s.freshness)) return false;
            if (!current(s, at)) return;
            const rows = append ? new Map(s.rows) : new Map(), seen = new Set();
            let freshness = append ? s.freshness : undefined;
            let cursor = append ? s.cursor : '', metadata = {}, count = 0, hasMore = false;
            for (; count < depth; count++) {
                const page = await read(s.server, { query: requestedQuery, cursor, limit: 50, signal: abort.signal });
                if (!current(s, at)) return;
                if (!page || !Array.isArray(page.artifacts)) throw new Error('The review page was not a list.');
                const stamp = Number.isSafeInteger(page.artifacts_rev) && page.artifacts_rev > 0 && typeof page.artifacts_board === 'string' && page.artifacts_board ? { rev: page.artifacts_rev, team: page.artifacts_board } : null;
                freshness = freshness === undefined ? stamp : freshness && stamp && freshness.rev === stamp.rev && freshness.team === stamp.team ? stamp : null;
                const next = typeof page.next_cursor === 'string' ? page.next_cursor : '';
                if (page.has_more && (!next || next === cursor || seen.has(next))) throw new Error('The review page did not provide a new cursor.');
                if (page.ownerOnly) rows.clear();
                const pairs = page.artifacts.map(row => {
                    const id = key(row, s.server);
                    if (typeof id !== 'string' || !id) throw new Error('A review row has no qualified identity.');
                    return [id, row];
                });
                for (const [id, row] of pairs) rows.set(id, row);
                metadata = { ...metadata, ...page }; hasMore = !!page.has_more; seen.add(cursor); cursor = next;
                if (!hasMore) { count++; break; }
            }
            // Nothing above changes the published window: a failed second refresh
            // page cannot clamp scroll by briefly replacing it with page one.
            s.freshness = freshness || null;
            s.rows = rows; s.loaded = true; s.more = hasMore; s.cursor = cursor;
            s.pages = append ? s.pages + count : count; s.ownerOnly = metadata.ownerOnly === true; s.truncated = metadata.truncated === true;
            if (!append) {
            if ('attention_total' in metadata) s.attentionTotal = Number.isSafeInteger(metadata.attention_total) && metadata.attention_total >= 0 ? metadata.attention_total : null;
            if (Number.isSafeInteger(metadata.total) && metadata.total >= 0) s.total = metadata.total;
            if (metadata.tag_counts && typeof metadata.tag_counts === 'object' && !Array.isArray(metadata.tag_counts)) s.tags = metadata.tag_counts;
            if (metadata.facets && typeof metadata.facets === 'object' && !Array.isArray(metadata.facets)) s.facets = metadata.facets;
            }
            return true;
        }).catch(error => {
            if (current(s, at) && error?.name !== 'AbortError') s.error = error?.message || 'The review page could not be read.';
            return true;
        }).finally(() => {
            if (current(s, at)) { s.pending = null; s.abort = null; changed(); }
        });
        changed(); return s.pending;
    }
    const load = () => Promise.all([...sources.values()].filter(s => !s.loaded).map(s => fetchPage(s, false)));
    const refresh = ({ unchanged = null } = {}) => Promise.all([...sources.values()].map(s => fetchPage(s, false, true, unchanged)));
    function more(server) {
        const s = sources.get(server);
        if (!s) return Promise.resolve();
        if (s.pending) return s.pending;
        if (!s.loaded) return fetchPage(s, false);
        if (s.error && !s.more) return fetchPage(s, false, true);
        return s.more ? fetchPage(s, true) : Promise.resolve();
    }
    function remove(predicate) {
        invalidate();
        for (const s of sources.values()) s.freshness = null;
        for (const s of sources.values()) for (const [id, row] of s.rows) if (predicate(row, s.server)) {
            s.rows.delete(id); s.total = null; s.attentionTotal = null; s.tags = null; s.facets = null;
        }
    }
    return { reset, setSources, load, refresh, more, remove, status, snapshot };
}
