/* The loaded window of one review query. Network/identity policy belongs to the
 * caller: read must use the source's protected route and return one parsed page.
 * This module never infers a computer, counts unread rows, or loads the next page
 * automatically. Each computer owns its cursor and failure state. */
export function createReviewPages({ read, key, changed = () => {} }) {
    if (typeof read !== 'function' || typeof key !== 'function') throw new TypeError('Review pages need a reader and a row key.');
    let generation = 0, query = '', sources = new Map();
    const copy = s => ({ server: s.server, artifacts: [...s.rows.values()], total: s.total, tag_counts: s.tags, facets: s.facets,
        loaded: s.loaded, loading: !!s.pending, has_more: s.more, next_cursor: s.cursor, error: s.error });
    const snapshot = () => [...sources.values()].map(copy);
    const current = (s, at) => generation === at && sources.get(s.server) === s;
    function reset(servers, nextQuery = '') {
        if (typeof nextQuery !== 'string') throw new TypeError('The review query must be serialized.');
        if (!Array.isArray(servers) || servers.some(s => typeof s !== 'string' || !s)) throw new TypeError('Each review source must name its computer.');
        for (const s of sources.values()) s.abort?.abort();
        generation++; query = nextQuery;
        sources = new Map([...new Set(servers)].map(server => [server, { server, rows: new Map(), loaded: false, pending: null,
            abort: null, total: null, tags: null, facets: null, cursor: '', more: false, error: '' }]));
        changed();
    }
    function fetchPage(s, append) {
        if (s.pending) return s.pending;
        const at = generation, requestedQuery = query, cursor = append ? s.cursor : '', abort = s.abort = new AbortController();
        s.error = '';
        s.pending = Promise.resolve().then(() => current(s, at) ? read(s.server, { query: requestedQuery, cursor, limit: 50, signal: abort.signal }) : null).then(page => {
            if (!current(s, at)) return;
            if (!page || !Array.isArray(page.artifacts)) throw new Error('The review page was not a list.');
            const next = typeof page.next_cursor === 'string' ? page.next_cursor : '';
            if (page.has_more && (!next || next === cursor)) throw new Error('The review page did not provide a new cursor.');
            // Validate all identities before changing the loaded window. A bad page
            // must not partially append rows or change a cursor that Retry needs.
            const pairs = page.artifacts.map(row => {
                const id = key(row, s.server);
                if (typeof id !== 'string' || !id) throw new Error('A review row has no qualified identity.');
                return [id, row];
            });
            const rows = append ? new Map(s.rows) : new Map();
            for (const [id, row] of pairs) rows.set(id, row);
            s.rows = rows; s.loaded = true; s.more = !!page.has_more; s.cursor = next;
            if (Number.isSafeInteger(page.total) && page.total >= 0) s.total = page.total;
            if (page.tag_counts && typeof page.tag_counts === 'object' && !Array.isArray(page.tag_counts)) s.tags = page.tag_counts;
            if (page.facets && typeof page.facets === 'object' && !Array.isArray(page.facets)) s.facets = page.facets;
        }).catch(error => {
            if (current(s, at) && error?.name !== 'AbortError') s.error = error?.message || 'The review page could not be read.';
        }).finally(() => {
            if (current(s, at)) { s.pending = null; s.abort = null; changed(); }
        });
        changed();
        return s.pending;
    }
    const load = () => Promise.all([...sources.values()].filter(s => !s.loaded).map(s => fetchPage(s, false)));
    function more(server) {
        const s = sources.get(server);
        if (!s) return Promise.resolve();
        if (s.pending) return s.pending;
        if (!s.loaded) return fetchPage(s, false);
        return s.more ? fetchPage(s, true) : Promise.resolve();
    }
    return { reset, load, more, snapshot };
}
