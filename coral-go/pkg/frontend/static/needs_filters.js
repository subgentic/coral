import { serverFilter } from './inbox_servers.js';
/* The Inbox Needs you folder's search, pills and Filters (#8604, UI/UX #8589 section 9): what they are, how they are kept in the browser, and how a waiting agent is matched against them. Pure (no DOM; it
 * imports the model and the browser store) so it is tested on its own; inbox_toolbar.js draws the controls on the shared list bar. Every field is one the rows already carry (the agent, its team, the kind of
 * what it waits on, since when): no server field. */
import { defineFilters } from './filter_model.js';
import { browserLocal } from './safe_storage.js';

/** What an agent waits on, as the pills say it: its permission, its question, or anything else (an input request, a plan, a prompt only the screen showed). */
export const KINDS = ['permission', 'question', 'other', 'review', 'run'];
export const KIND_LABEL = { permission: 'Permission', question: 'Question', other: 'Needs input', review: 'For review', run: 'Failed run' };
/** How long it has waited, at least (minutes), as the Filters panel offers it. */
export const LONGER = ['5', '15', '60', '240'];
export const LONGER_LABEL = { 5: '5 minutes', 15: '15 minutes', 60: '1 hour', 240: '4 hours' };
export const SORTS = ['oldest', 'newest'];
export const SORT_LABEL = { oldest: 'Waiting longest', newest: 'Waiting least' };

const model = defineFilters({
    server: serverFilter,
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    kind: { type: 'choice', values: KINDS }, // the pills of the toolbar: a shortcut of this field, so it has no chip of its own
    team: { type: 'custom', empty: '', clean: v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : ''), filtered: v => !!v, chip: v => `Team: ${v}`, clear: f => ({ ...f, team: '' }) },
    agent: { type: 'text', max: 80, chip: v => `Agent: ${v}` },
    goal: { type: 'text', max: 200, chip: v => `Goal: ${v}` }, // the goal a row's task serves, or "No goal" (#8917)
    longer: { type: 'choice', values: LONGER, chip: v => `Waiting longer than ${LONGER_LABEL[v]}` },
    sort: { type: 'order', values: SORTS, default: 'oldest' },
});
export const { EMPTY, clean, isFiltered, isQuery, chips, without } = model;

export const storageKey = () => 'coral-inbox-needs-filters';
const kept = model.persist(storageKey);
/** The filters kept in this browser for the folder (the search words are not kept), or the empty ones. */
export const loadFilters = () => ({ ...kept.load('inbox-needs', browserLocal), q: '' });
export const saveFilters = f => kept.save('inbox-needs', { ...f, q: '' }, browserLocal);

/** The kind of a waiting agent for the pills: `waiting_kind` permission or question, else other. */
export const kindOf = s => (s && (s.waiting_kind === 'permission' || s.waiting_kind === 'question' || s.waiting_kind === 'review' || s.waiting_kind === 'run') ? s.waiting_kind : 'other');

/** Whether a waiting agent passes the filters. ctx: { text(s) the words the search covers, teamOf(s), nameOf(s) }; `now` (ms) is the clock. The pill's kind is a filter here too. */
export function matches(s, f, ctx, now = Date.now()) {
    const c = clean(f);
    if (c.q && !ctx.text(s).toLowerCase().includes(c.q.toLowerCase())) return false;
    if (c.kind && kindOf(s) !== c.kind) return false;
    if (c.team && ctx.teamOf(s) !== c.team) return false;
    if (c.agent && ctx.nameOf(s) !== c.agent) return false;
    if (c.goal && ctx.goalOf && ctx.goalOf(s) !== c.goal) return false;
    if (c.longer) {
        const since = Date.parse(s.waiting_since || '');
        if (!Number.isFinite(since) || now - since < Number(c.longer) * 60000) return false; // no time to go by is not "longer than"
    }
    return true;
}

/** The waiting agents in the order the filters ask for (a new array): longest waiting first by default; one with no time goes last either way. */
export function ordered(sessions, f) {
    const c = clean(f), at = s => { const t = Date.parse(s.waiting_since || ''); return Number.isFinite(t) ? t : null; };
    const dir = c.sort === 'newest' ? -1 : 1;
    return [...sessions].sort((a, b) => { const x = at(a), y = at(b); if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; return dir * (x - y); });
}
