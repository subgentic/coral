/* The Team Artifacts panel's search, filters and sort (#4573): what they are, how they are kept per board and how they become the list route's query. Pure (no DOM, no imports)
 * so it can be tested on its own; team_artifact_bar.js draws the controls and team_artifacts.js asks the server. The server does the matching: a search covers every artifact,
 * not just the loaded page. */

import { defineFilters, localMidnight } from './filter_model.js';

export const KINDS = ['image', 'pdf', 'text', 'other'];
export const ORIGINS = ['shared', 'received', 'unlisted'];
export const SORTS = ['newest', 'oldest', 'name', 'size'];
export const KIND_LABEL = { image: 'Image', pdf: 'PDF', text: 'Text', other: 'Other' };
export const ORIGIN_LABEL = { shared: 'Shared here', received: 'Received', unlisted: 'Unlisted' };
export const SORT_LABEL = { newest: 'Newest', oldest: 'Oldest', name: 'Name', size: 'Size' };
const FIELDS = {
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    kind: { type: 'choice', values: KINDS, chip: v => `Type: ${KIND_LABEL[v]}` },
    origin: { type: 'choice', values: ORIGINS, chip: v => `Origin: ${ORIGIN_LABEL[v]}` },
    by: { type: 'text', max: 80, chip: v => `By: ${v}` },
    kept: { type: 'flag', chip: 'Kept' },
    dates: { type: 'range', from: 'from', to: 'to', chip: (a, b) => (a && b ? `${a} to ${b}` : a ? `From ${a}` : `Until ${b}`) },
    sort: { type: 'order', values: SORTS, default: 'newest' },
};
const model = defineFilters(FIELDS);
export const { EMPTY, clean, isFiltered, chips, without } = model;

const kept = model.persist(team => `coral-team-artifacts-filters:${team}`);
export const { storageKey } = kept;
/** The filters kept for a board, or the empty ones. store is browserLocal (every read and write is guarded there). */
export const loadFilters = kept.load;
export const saveFilters = kept.save;

/** The Inbox's list across teams (Goal #62): the same filters plus the team (a team's id), kept under its own key. */
export const INBOX = (() => {
    const m = defineFilters({ q: FIELDS.q, team: { type: 'text', max: 200, chip: v => `Team: ${v}` }, ...Object.fromEntries(Object.entries(FIELDS).filter(([k]) => k !== 'q')) });
    const p = m.persist(key => `coral-team-artifacts-filters:${key}`);
    return { EMPTY: m.EMPTY, clean: m.clean, isFiltered: m.isFiltered, chips: m.chips, without: m.without, load: p.load, save: p.save };
})();

/** The query parameters for the list route (the names are the server's: team_artifacts.go ListTeamArtifacts: q, kind, origin, by, kept, since, until, sort). Empty filters send nothing;
 *  sort is always sent, which makes it a query: the reply then carries the filtered total and a cursor for the next page. */
export function toParams(f) {
    const c = f && typeof f.team === 'string' ? INBOX.clean(f) : clean(f); // the Inbox's filters carry a team
    if (!c) return {};
    const p = {};
    if (c.q) p.q = c.q;
    if (c.team) p.team = c.team;
    if (c.kind) p.kind = c.kind;
    if (c.origin) p.origin = c.origin;
    if (c.by) p.by = c.by;
    if (c.kept) p.kept = 'true';
    if (c.from) p.since = localMidnight(c.from);
    if (c.to) p.until = localMidnight(c.to, 1);
    p.sort = c.sort;
    return p;
}
