import { serverFilter } from './inbox_servers.js';
import { identityKey } from './server_base.js';
/* The Saved for later panel's search, filters and order (#4778): what they are and how they become GET /api/saved's parameters (q, sort: #4745; kind and conv were there). Pure (no DOM, no
 * imports) so it can be tested on its own; saved.js draws the bar and reads the list again. The server matches the title and the snippet. The Open and Done tabs stay as they are: they say
 * which half of the matches is shown. */

import { defineFilters, localMidnight, text, SORT_PARAM } from './filter_model.js';
import { browserLocal } from './safe_storage.js';

/** The Team filter's value for a bookmark: its team's key (a name, or @server/name for another computer), so two computers' teams called alpha are two choices (#8839); '' with no team. */
export const teamKeyOf = it => (it && it.team ? identityKey(it.server, it.team) : '');
let teamNames = new Map();
/** The words the chip says for each team key (the page sets them when it builds the choices). */
export function setTeamNames(map) { teamNames = map instanceof Map ? map : new Map(); }

export const KINDS = ['agent', 'board'];
export const KIND_LABEL = { agent: 'Agent chat', board: 'Board message' };
export const SORTS = ['newest', 'oldest'];
export const SORT_LABEL = { newest: 'Newest saved', oldest: 'Oldest saved' };

// convLabel turns a stored conversation reference into the title the person reads in its chip
const filters = convLabel => defineFilters({
    server: serverFilter,
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    kind: { type: 'choice', values: KINDS, chip: v => `Type: ${KIND_LABEL[v]}` },
    conv: { type: 'text', max: 300, chip: v => `From: ${convLabel(v)}` },
    team: { type: 'custom', empty: '', clean: v => text(v, 200), filtered: v => !!v, chip: v => `Team: ${teamNames.get(v) || v}`, clear: f => ({ ...f, team: '' }) }, // the Inbox page's (#8602): kept by the page, not asked of the server
    from: { type: 'day', chip: v => `Saved since ${v}` },
    sort: { type: 'order', values: SORTS, default: 'newest' },
});
const model = filters(v => v);
export const { EMPTY, clean, isFiltered, isQuery } = model;

const kept = model.persist(() => 'coral-saved-filters');
/** The filters kept in this browser for Saved (the search words are not kept), or the empty ones. */
export const loadFilters = () => ({ ...kept.load('saved', browserLocal), q: '' });
export const saveFilters = f => kept.save('saved', { ...f, q: '' }, browserLocal);

/** The model the shared list bar takes; convLabel turns a stored conversation reference into the title the person reads. */
export function makeModel({ convLabel = v => v } = {}) {
    const { chips, without } = filters(convLabel);
    return { EMPTY, clean, isFiltered, chips, without };
}

/** The filters the page applies to what the server sent (the server's list has no team or saved-since parameter): the bookmark's team, and the day it was saved from. */
export function keeps(it, f) {
    const c = clean(f);
    if (c.team && teamKeyOf(it) !== c.team) return false;
    if (c.from && !((Date.parse(it.saved_at || '') || 0) >= Date.parse(localMidnight(c.from)))) return false;
    return true;
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
