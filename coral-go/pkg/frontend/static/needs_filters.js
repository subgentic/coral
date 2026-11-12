import { importOnce } from './import_once.js';
import { serverUrl } from './server_base.js';
const { artifactThumbnail, thumbnailPath } = await importOnce('./artifact_thumbnail.js');
import { serverFilter } from './inbox_servers.js';
/* The Inbox Needs you folder's search, pills and Filters (#8604, UI/UX #8589 section 9): what they are, how they are kept in the browser, and how a waiting agent is matched against them. Pure (no DOM; it
 * imports the model and the browser store) so it is tested on its own; inbox_toolbar.js draws the controls on the shared list bar. Every field is one the rows already carry (the agent, its team, the kind of
 * what it waits on, since when): no server field. */
import { defineFilters } from './filter_model.js';
import { browserLocal } from './safe_storage.js';

/** What an agent waits on, as the pills say it: its permission, its question, or anything else (an input request, a plan, a prompt only the screen showed). */
export const KINDS = ['permission', 'question', 'other', 'review', 'run', 'proposal', 'goal_done', 'skill_review', 'welcome'];
export const KIND_LABEL = { permission: 'Permission', question: 'Question', other: 'Needs input', review: 'For review', run: 'Failed run', proposal: 'To approve', goal_done: 'Goal looks done', skill_review: 'Skill to approve', welcome: 'Welcome', ask: 'Question' };
/** How long it has waited, at least (minutes), as the Filters panel offers it. */
export const LONGER = ['5', '15', '60', '240'];
export const LONGER_LABEL = { 5: '5 minutes', 15: '15 minutes', 60: '1 hour', 240: '4 hours' };
export const SORTS = ['newest', 'oldest', 'blockers'];
export const SORT_LABEL = { blockers: 'Blocking first', oldest: 'Waiting longest', newest: 'Waiting least' }; // Blocking first (#11442): what holds up the most work, a high-priority task first, then how long it has waited

const model = defineFilters({
    server: serverFilter,
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    kind: { type: 'choice', values: KINDS }, // the pills of the toolbar: a shortcut of this field, so it has no chip of its own
    team: { type: 'custom', empty: '', clean: v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : ''), filtered: v => !!v, chip: v => `Team: ${v}`, clear: f => ({ ...f, team: '' }) },
    agent: { type: 'text', max: 80, chip: v => `Agent: ${v}` },
    goal: { type: 'text', max: 200, chip: v => `Goal: ${v}` }, // the goal a row's task serves, or "No goal" (#8917)
    longer: { type: 'choice', values: LONGER, chip: v => `Waiting longer than ${LONGER_LABEL[v]}` },
    sort: { type: 'order', values: SORTS, default: 'newest' }, // newest first (#11552, the operator); Blocking first is one pick away and, once picked, kept
});
export const { EMPTY, clean, isFiltered, isQuery, chips, without } = model;

export const storageKey = () => 'coral-inbox-needs-filters';
const kept = model.persist(storageKey);
/** The filters kept in this browser for the folder (the search words are not kept), or the empty ones. */
export const loadFilters = () => ({ ...kept.load('inbox-needs', browserLocal), q: '' });
export const saveFilters = f => kept.save('inbox-needs', { ...f, q: '' }, browserLocal);

/** The leading icon of a Needs you row (#13144): one glyph per kind, drawn in a full-height gutter by css/data_table.css from data-kind (all from the icon subset, tests/frontend/fixtures/material-icons.names.txt), named by the kind's own word for a screen reader. The glyph is drawn by CSS (data-kind), so the row's text stays its words. */
export function kindIcon(s) {
    const k = s && s.waiting_kind === 'ask' ? 'ask' : kindOf(s), i = document.createElement('span'); // a question put to the Operator is a question, not "needs input" (#13819); it is still the 'other' pill's, so no filter changes
    i.className = 'material-icons inbox-kind-icon'; i.dataset.kind = k; i.setAttribute('role', 'img'); i.setAttribute('aria-label', KIND_LABEL[k]); i.title = KIND_LABEL[k];
    if (s?.review) { i.classList.add('inbox-artifact-thumbnail'); i.append(artifactThumbnail(s.review, { size: 32, url: typeof s.server === 'string' && thumbnailPath(s.review) ? serverUrl(thumbnailPath(s.review), s.server) : '' })); }
    return i;
}
/** A row's item cell with its kind's icon in front (a string cell becomes a span). */
export function withKindIcon(s, cell) {
    const node = typeof cell === 'string' || !cell ? Object.assign(document.createElement('span'), { textContent: cell || '' }) : cell;
    node.insertBefore(kindIcon(s), node.firstChild);
    return node;
}
/** Reserve one full-height icon gutter without changing the table's data/action columns. */
export function decorateKindRow(tr) {
    const icon = tr.querySelector('.inbox-kind-icon');
    if (!icon || tr.classList.contains('dt-mailed')) return;
    tr.classList.add('inbox-kind-row');
    const words = tr.querySelector('.dt-subtitle'); if (words) words.classList.add('inbox-row-words'); /* the row's own class for it: the lazy card CSS styles this, not the table's (data_table_census) */ const wrap = tr.querySelector('.inbox-agent-first'), kindWord = words && /^(For review|Needs your answer)$/.test(words.textContent.trim());
    const phone = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 760px)').matches, holds = phone && wrap && tr.querySelector('.inbox-blocks'); // what a file or an agent holds up goes on the description's own lines, after it, never as a line of its own (#13911: three lines at most)
    if (holds && holds.textContent.trim()) { wrap.classList.add('has-holds'); holds.classList.add('inbox-holds-inline'); wrap.append(holds); const news = wrap.querySelector('.inbox-new-comments'); if (news) holds.prepend(news, ' '); } // the row's third line: the file's name takes one line, what it holds up the next; the file's question gives way to it
    if (words && wrap && !kindWord && !tr.querySelector('.inbox-holds-inline') && tr.querySelector('[data-review-artifact]') && words.textContent.trim()) { wrap.classList.add('has-question'); words.classList.add('inbox-file-question'); } // the question put on a file (#11555) is what the person is to decide: it stays, as the one line under the file's name
    else if (words && (wrap || kindWord)) words.classList.add('inbox-kind-words'); // a phone's one row has its own two lines: the second line of the old row is for a screen reader only (#13911) // the kind's own words under the sender: a phone leaves them to the icon (#13795)
    const cell = icon.closest('td'), column = document.createElement('span');
    column.className = 'inbox-kind-column'; column.append(icon); cell.append(column);
}
/** The kind of a waiting agent for the pills: `waiting_kind` permission or question, else other. */
export const kindOf = s => (s && (s.waiting_kind === 'permission' || s.waiting_kind === 'question' || s.waiting_kind === 'review' || s.waiting_kind === 'run' || s.waiting_kind === 'proposal' || s.waiting_kind === 'goal_done' || s.waiting_kind === 'skill_review' || s.waiting_kind === 'welcome') ? s.waiting_kind : 'other');

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

/** Keeps the order a person is looking at (#12636): a row already shown stays where it is, in its old order. A row that is new goes after them (a computer that answered late brings rows that would otherwise
 *  slot in among the ones on screen), except one that sorts above everything on screen: that is the freshest arrival, as in any inbox, and goes on top (the Inbox shows only a few review rows per agent, so a
 *  new version of a file at the bottom would be hidden). `memory` is { sig, rank: Map(key -> place) }, kept by the caller; a different `sig` (filters, sort, search changed) or none starts the order afresh.
 *  The returned memory is the order of what is returned, so a second call with the same rows gives the same list. */
export function keepOrder(rows, keyOf, memory, sig) {
    const rank = memory && memory.sig === sig ? memory.rank : new Map();
    const seen = [], fresh = [], at = new Map(rows.map((r, i) => [keyOf(r), i]));
    for (const r of rows) (rank.has(keyOf(r)) ? seen : fresh).push(r);
    seen.sort((a, b) => rank.get(keyOf(a)) - rank.get(keyOf(b)));
    const first = seen.length ? Math.min(...seen.map(r => at.get(keyOf(r)))) : Infinity;
    const out = [...fresh.filter(r => at.get(keyOf(r)) < first), ...seen, ...fresh.filter(r => at.get(keyOf(r)) >= first)];
    return { rows: out, memory: { sig, rank: new Map(out.map((r, i) => [keyOf(r), i])) } };
}

/** The waiting agents in the order the filters ask for (a new array): longest waiting first by default; one with no time goes last either way. */
export function ordered(sessions, f, weightOf = () => 0) {
    const c = clean(f), at = s => { const t = Date.parse(s.waiting_since || ''); return Number.isFinite(t) ? t : null; };
    const dir = c.sort === 'newest' ? -1 : 1;
    const byAge = (a, b) => { const x = at(a), y = at(b); if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; return dir * (x - y); };
    return [...sessions].sort((a, b) => (c.sort === 'blockers' ? (weightOf(b) - weightOf(a)) || byAge(a, b) : byAge(a, b)));
}
