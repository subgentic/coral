/* What waits on a Needs you item (#11442), said as a phrase. The server counts it (#11455): a live agent row and a "for review" row carry waits_on_this { count, top_title, priority, closes_goal }, worked out from
 * the tasks of EVERY board that list the item's task as a blocker (an agent's in-progress tasks, a review's task and the goal it would close). infoOf reads that field; the phrases and the weight that sorts blockers first
 * are here too. A row without the field (a failed run, a commit, a remote Coral, an agent with nothing in progress) says nothing. Lazy: loaded by the Needs you folder when a row carries the field (inbox_sidebar.js). */

/** The row's field as the phrases read it, or null when nothing waits on it and no goal closes. */
export function infoOf(w) {
    if (!w || typeof w !== 'object') return null;
    const count = Math.max(0, Number(w.count) || 0), closes = String(w.closes_goal || '');
    if (!count && !closes) return null;
    return { count, first: String(w.top_title || ''), high: w.priority === 'critical' || w.priority === 'high', closes };
}

/** The phrase for a row: one waiter named, several counted, a high-priority one first, the goal it closes last. */
export function phraseOf(info, mark = t => t) {
    if (!info) return '';
    const first = mark(info.first).trim() || 'a task', closes = mark(info.closes).trim() || 'a goal'; // a title is an agent's text: the caller's mark writes out what hides or reorders it (markHidden strict, #11399; passed in so this lazy module imports nothing new)
    const core = info.count === 1 ? `“${first}” waits on this` : info.count > 1 ? `${info.count} tasks wait on this` : '';
    const text = core ? (info.high ? 'High priority: ' : '') + core + (info.closes ? ` · closes goal “${closes}”` : '') : `Closes goal “${closes}”`;
    return text;
}

/** The same, short, for a one-line row on a phone, where the whole sentence is cut off: "Blocks 3 tasks", "Blocks “Tag v2.0.10”", "Closes a goal". The whole sentence is the row's tooltip. */
export function shortPhraseOf(info, mark = t => t) {
    if (!info) return '';
    if (info.count === 1) return `Blocks “${mark(info.first).trim() || 'a task'}”`;
    if (info.count > 1) return `Blocks ${info.count} tasks`;
    return 'Closes a goal';
}

/** How much the row blocks, for the sort: a high-priority waiter first, then the count, then a goal that closes. */
export const weightOf = info => (info ? (info.high ? 1000 : 0) + info.count * 10 + (info.closes ? 1 : 0) : 0);
