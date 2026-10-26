/* The Saved for later panel's search, filters and order (#4778): what they are and how they become GET /api/saved's parameters (q, sort: #4745; kind and conv were there). Pure (no DOM, no
 * imports) so it can be tested on its own; saved.js draws the bar and reads the list again. The server matches the title and the snippet. The Open and Done tabs stay as they are: they say
 * which half of the matches is shown. */

import { defineFilters, SORT_PARAM } from './filter_model.js';

export const KINDS = ['agent', 'board'];
export const KIND_LABEL = { agent: 'Agent chat', board: 'Board message' };
export const SORTS = ['newest', 'oldest'];
export const SORT_LABEL = { newest: 'Newest saved', oldest: 'Oldest saved' };

// convLabel turns a stored conversation reference into the title the person reads in its chip
const filters = convLabel => defineFilters({
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    kind: { type: 'choice', values: KINDS, chip: v => `Type: ${KIND_LABEL[v]}` },
    conv: { type: 'text', max: 300, chip: v => `From: ${convLabel(v)}` },
    sort: { type: 'sort', values: SORTS, default: 'newest' },
});
const model = filters(v => v);
export const { EMPTY, clean, isFiltered, isQuery } = model;

/** The model the shared list bar takes; convLabel turns a stored conversation reference into the title the person reads. */
export function makeModel({ convLabel = v => v } = {}) {
    const { chips, without } = filters(convLabel);
    return { EMPTY, clean, isFiltered, chips, without };
}

/** The query string for GET /api/saved ("" for the plain read): q, kind, conv (the conversation's reference) and the order. */
export function toQuery(f) {
    const c = clean(f);
    const p = new URLSearchParams();
    if (c.q) p.set('q', c.q);
    if (c.kind) p.set('kind', c.kind);
    if (c.conv) p.set('conv', c.conv);
    if (c.sort !== 'newest') p.set(SORT_PARAM, c.sort);
    const s = p.toString();
    return s ? `?${s}` : '';
}
