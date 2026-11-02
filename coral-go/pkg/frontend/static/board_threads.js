/* Threads on the board (#12502, #12491: the Operator, "move under the thread"): a reply sits under the message it answers, however late it was posted. The loaded messages stay in the order they came in (rows,
 * windows and trims count on it); only the order the rows are drawn in changes. One level: a reply to a reply sits under the first message of the thread, in time order. A reply whose message is not loaded stays
 * where it was posted and keeps its "in reply to" chip. */

/** items (groupTaskQueueRuns' rows) in thread order; each reply that moved is marked nested. */
export function threadItems(items) {
    const byId = new Map();
    for (const it of items) if (it.kind === 'msg') byId.set(Number(it.m.id), it);
    const rootOf = (it, guard = 0) => {
        const parent = it.m.reply_to ? byId.get(Number(it.m.reply_to)) : null;
        return !parent || parent === it || guard > 50 ? null : (rootOf(parent, guard + 1) || parent);
    };
    const kids = new Map();
    for (const it of items) {
        if (it.kind !== 'msg') continue;
        const root = rootOf(it);
        if (!root) continue;
        it.nested = true;
        if (!kids.has(root)) kids.set(root, []);
        kids.get(root).push(it);
    }
    if (!kids.size) return items;
    const out = [];
    for (const it of items) {
        if (it.nested) continue;
        out.push(it);
        if (kids.has(it)) out.push(...kids.get(it));
    }
    return out;
}

/** True when drawing these messages needs the thread order: some message answers one that is loaded. */
export function hasThreads(messages) {
    const ids = new Set(messages.map(m => Number(m.id)));
    return messages.some(m => m.reply_to && ids.has(Number(m.reply_to)));
}

/** True when one of the last `count` messages answers a message that is loaded: it moves up under it, so the rows are drawn again. */
export function answersLoaded(messages, count) {
    const ids = new Set(messages.map(m => Number(m.id)));
    return messages.slice(-count).some(m => m.reply_to && ids.has(Number(m.reply_to)));
}
