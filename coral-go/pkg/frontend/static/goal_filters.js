/* The Inbox Goals folder's search, pills and Filters (#8596, UI/UX #8589 section 9): what they are, how they are kept in the browser and how a goal is matched against them. Pure (no DOM; it imports the
 * model and the browser store) so it is tested on its own; inbox_toolbar.js draws the controls on the shared list bar and inbox_sidebar.js asks the rows. The goals are the ones GET /api/goals sends (open goals of every team), so
 * every field here is one the rows already carry: no new server field. */
import { defineFilters, localMidnight, text } from './filter_model.js';
import { browserLocal } from './safe_storage.js';

export const STATES = ['active', 'blocked', 'proposed', 'done'];
export const STATE_LABEL = { active: 'Active', blocked: 'Blocked', proposed: 'Proposed', done: 'Done' };
export const SORTS = ['newest', 'oldest', 'title'];
export const SORT_LABEL = { newest: 'Recently updated', oldest: 'Least recently updated', title: 'Title' };

/** The team names by board id, for the team chip's words (the page sets them from the goals it has read; an id it does not know is shown as it is). */
let teamNames = new Map();
export function setTeamNames(map) { teamNames = map instanceof Map ? map : new Map(); }
const teamChip = v => `Team: ${teamNames.get(v) || v}`;

const model = defineFilters({
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    state: { type: 'choice', values: STATES }, // the pills of the toolbar: a shortcut of this field, so it has no chip of its own
    team: { type: 'custom', empty: '', clean: v => text(v, 200), filtered: v => !!v, chip: teamChip, clear: f => ({ ...f, team: '' }) },
    driver: { type: 'custom', empty: '', clean: v => text(v, 80), filtered: v => !!v, chip: v => `Driver: ${v}`, clear: f => ({ ...f, driver: '' }) },
    from: { type: 'day', chip: v => `Updated since ${v}` },
    sort: { type: 'order', values: SORTS, default: 'newest' },
});
export const { EMPTY, clean, isFiltered, isQuery, chips, without } = model;

export const storageKey = () => 'coral-inbox-goals-filters';
const kept = model.persist(storageKey);
/** The filters kept in this browser for the folder, or the empty ones. */
export const loadFilters = () => ({ ...kept.load('inbox-goals', browserLocal), q: '' });
export const saveFilters = f => kept.save('inbox-goals', { ...f, q: '' }, browserLocal); // the search words are not kept: a page opened later starts with an empty box

const stamp = g => Date.parse(g.updated_at || g.updatedAt || '') || 0;

/** Whether a goal passes the filters. `teamOf(g)` is the words the Team column shows (the search covers them). The pill's state is a filter here too. */
export function matches(g, f, teamOf = x => x.board_id || '') {
    const c = clean(f);
    if (c.q) {
        const hay = [g.title, g.outcome, teamOf(g), g.state, g.driver].join(' ').toLowerCase();
        if (!hay.includes(c.q.toLowerCase())) return false;
    }
    if (c.state && String(g.state || '').toLowerCase() !== c.state) return false;
    if (c.team && g.board_id !== c.team) return false;
    if (c.driver && g.driver !== c.driver) return false;
    if (c.from && stamp(g) < Date.parse(localMidnight(c.from))) return false;
    return true;
}

/** The goals in the order the filters ask for (a new array). */
export function ordered(goals, f) {
    const c = clean(f);
    const list = [...goals];
    if (c.sort === 'title') return list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    return list.sort((a, b) => (c.sort === 'oldest' ? stamp(a) - stamp(b) : stamp(b) - stamp(a)));
}
