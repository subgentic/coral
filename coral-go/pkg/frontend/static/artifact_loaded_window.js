/* A first-page keep read updates the loaded prefix, not the extent the person
 * has paged through. Each computer owns its own opaque tail cursor. */
export function mergeArtifactWindow(previous, incoming, keyOf, sourceOf = null) {
    const parse = text => { try { const x = JSON.parse(text); return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { return {}; } };
    const oldCursors = sourceOf ? parse(previous.cursor) : { '': { cursor: previous.cursor, offset: previous.items.length, done: !previous.hasMore } };
    const freshCursors = sourceOf ? parse(incoming.next_cursor) : { '': { cursor: incoming.next_cursor || '', offset: incoming.artifacts.length, done: !incoming.has_more, total: incoming.total } };
    const source = sourceOf || (() => '');
    const items = [], cursors = [];
    for (const [id, next] of Object.entries(freshCursors)) {
        const old = previous.items.filter(row => source(row) === id);
        const fresh = incoming.artifacts.filter(row => source(row) === id);
        const prior = Object.hasOwn(oldCursors, id) ? oldCursors[id] : null;
        if (next.ownerOnly) { cursors.push([id, next]); continue; }
        if (next.failed && prior) {
            items.push(...old); cursors.push([id, { ...next, cursor: prior.cursor, offset: prior.offset, done: prior.done }]); continue;
        }
        const freshKeys = new Set(fresh.map(keyOf));
        // Anything before the last overlapping row was reread authoritatively:
        // missing rows there were removed. Rows beyond it are still cached.
        let end = -1;
        old.forEach((row, i) => { if (freshKeys.has(keyOf(row))) end = i; });
        const tail = next.done ? [] : old.slice(end + 1).filter(row => !freshKeys.has(keyOf(row)));
        const merged = [...fresh, ...tail];
        items.push(...merged);
        cursors.push([id, tail.length && prior ? {
            ...next, cursor: prior.cursor,
            offset: Math.max(0, (Number.isSafeInteger(prior.offset) ? prior.offset : old.length) + merged.length - old.length),
            done: !!prior.done && (!Number.isSafeInteger(next.total) || next.total <= merged.length),
        } : next]);
    }
    const next = Object.fromEntries(cursors);
    return { items, cursor: sourceOf ? JSON.stringify(next) : next['']?.cursor || '', hasMore: cursors.some(([, c]) => !c.done), truncated: !!incoming.truncated || !!previous.truncated };
}
