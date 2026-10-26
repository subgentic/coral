/* The message board's search and filters (#4771): what they are and how they become GET /api/board/{project}/messages/search's parameters (#4745). Pure (no DOM, no imports) so it can be tested on
 * its own; board_search.js draws the bar and walks the matches. A search is not kept: it belongs to the board on screen and goes when the board does. The server matches every message of the
 * board, not just the loaded page. */

import { defineFilters, localMidnight, SORT_PARAM } from './filter_model.js';

// The search text is in the search box itself: no chip for it (the board's tools row is already tall on a phone). The two dates are one chip.
const model = defineFilters({
    q: { type: 'text', max: 200 },
    from: { type: 'text', max: 80, chip: v => `From: ${v}` },
    mentions: { type: 'flag', chip: 'Mentions me' },
    dates: { type: 'range', from: 'since', to: 'until', chip: (a, b) => (a && b ? `${a} to ${b}` : a ? `Since ${a}` : `Until ${b}`) },
});
export const { EMPTY, clean, isFiltered, chips, without } = model;

/** The query parameters as [name, value] pairs (the server's: q, from, mentions, since, until, sort, limit, cursor). `me` is the name the Operator is tagged by. newest-first is the order the
 *  matches are numbered in, 1 being the latest. */
export function toParams(f, { me = '', limit = 50, cursor = '' } = {}) {
    const c = clean(f);
    const p = [];
    if (c.q) p.push(['q', c.q]);
    if (c.from) p.push(['from', c.from]);
    if (c.mentions && me) p.push(['mentions', me]);
    if (c.since) p.push(['since', localMidnight(c.since)]);
    if (c.until) p.push(['until', localMidnight(c.until, 1)]);
    p.push([SORT_PARAM, 'newest']);
    p.push(['limit', String(limit)]);
    if (cursor) p.push(['cursor', cursor]);
    return p;
}

/** The words of the results line: where the current match is among all of them ("3 of 74 matches"), or that there are none. */
export function resultsText(index, total, truncated = false) {
    if (!total) return 'No messages match';
    return `${index + 1} of ${total}${truncated ? '+' : ''} match${total === 1 && !truncated ? '' : 'es'}`; // '+': the search hit the server's bound, there may be more
}
