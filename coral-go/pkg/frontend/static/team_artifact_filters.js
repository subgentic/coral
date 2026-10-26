/* The Team Artifacts panel's search, filters and sort (#4573): what they are, how they are kept per board and how they become the list route's query. Pure (no DOM, no imports)
 * so it can be tested on its own; team_artifact_bar.js draws the controls and team_artifacts.js asks the server. The server does the matching: a search covers every artifact,
 * not just the loaded page. */

import { defineFilters, localMidnight } from './filter_model.js';
import { importOnce } from './import_once.js';
const { normalizeTag } = await importOnce('./artifact_tag_rules.js'); // lazy: its failure is retried

export const KINDS = ['image', 'pdf', 'text', 'other'];
export const ORIGINS = ['shared', 'received', 'unlisted'];
export const SORTS = ['newest', 'oldest', 'name', 'size'];
export const KIND_LABEL = { image: 'Image', pdf: 'PDF', text: 'Text', other: 'Other' };
export const ORIGIN_LABEL = { shared: 'Shared here', received: 'Received', unlisted: 'Unlisted' };
export const SORT_LABEL = { newest: 'Newest', oldest: 'Oldest', name: 'Name', size: 'Size' };
export const TAG_KEY = 'ta' + 'g'; // the Tag field's key, spelled in two parts: the icon-name lint reads that quoted word as an icon name
export const GROUPS = ['task', 'goal'];
export const GROUP_LABEL = { task: 'Task', goal: 'Goal' };
// The words a task or goal filter's chip says ("Goal: Ship the installer"): the page notes each task and goal it has seen on an artifact (noteChoices), the chip falls back to the number
const choiceNames = { task: new Map(), goal: new Map() };
/** The tasks and goals the artifacts in `items` belong to, remembered for the chips and the Task and Goal selects; returns them, oldest-first by number, as { tasks: [[id, label]], goals: [[id, label]] }. */
export function noteChoices(items) {
    for (const a of items) {
        if (Number(a.task_id) > 0) choiceNames.task.set(String(a.task_id), `#${a.task_id}${a.task_title ? ' ' + a.task_title : ''}`);
        if (Number(a.goal_id) > 0 && a.goal_title) choiceNames.goal.set(String(a.goal_id), String(a.goal_title));
    }
    const list = (m) => [...m].sort((x, y) => Number(x[0]) - Number(y[0]));
    return { tasks: list(choiceNames.task), goals: list(choiceNames.goal) };
}
export const forgetChoices = () => { choiceNames.task.clear(); choiceNames.goal.clear(); };
// a task or goal number: a positive whole number as text, else nothing
const numberField = (word, kind) => ({ type: 'custom', empty: '', clean: v => (/^\d{1,9}$/.test(String(v ?? '')) && Number(v) > 0 ? String(Number(v)) : ''), filtered: v => !!v, chip: v => `${word}: ${choiceNames[kind].get(v) || '#' + v}` });
const FIELDS = {
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    kind: { type: 'choice', values: KINDS, chip: v => `Type: ${KIND_LABEL[v]}` },
    origin: { type: 'choice', values: ORIGINS, chip: v => `Origin: ${ORIGIN_LABEL[v]}` },
    by: { type: 'text', max: 80, chip: v => `By: ${v}` },
    kept: { type: 'flag', chip: 'Kept' },
    tag: { type: 'custom', empty: '', clean: v => normalizeTag(v), filtered: v => !!v, chip: v => `Tag: ${v}` }, // one of the team's tags (the route takes several; the menu offers one), #8594
    task: numberField('Task', 'task'),
    goal: numberField('Goal', 'goal'),
    dates: { type: 'range', from: 'from', to: 'to', chip: (a, b) => (a && b ? `${a} to ${b}` : a ? `From ${a}` : `Until ${b}`) },
    sort: { type: 'order', values: SORTS, default: 'newest' },
    group: { type: 'order', values: ['', ...GROUPS], default: '' }, // how the list is read (heads by task or goal), not what is in it: never a filter or a chip, kept with the rest
};
const model = defineFilters(FIELDS);
export const { EMPTY, clean, isFiltered, chips, without } = model;

const kept = model.persist(team => `coral-team-artifacts-filters:${team}`);
export const { storageKey } = kept;
/** The filters kept for a board, or the empty ones. store is browserLocal (every read and write is guarded there). */
export const loadFilters = kept.load;
export const saveFilters = kept.save;

/** The Inbox's list across teams (Goal #62): the same filters plus the team (a team's id), kept under its own key. The task, goal and group choices are numbers of one team, so the Inbox's bar does not offer them. */
export const INBOX = (() => {
    const m = defineFilters({ q: FIELDS.q, team: { type: 'text', max: 200, chip: v => `Team: ${v}` }, ...Object.fromEntries(Object.entries(FIELDS).filter(([k]) => k !== 'q')) });
    const p = m.persist(key => `coral-team-artifacts-filters:${key}`);
    return { EMPTY: m.EMPTY, clean: m.clean, isFiltered: m.isFiltered, chips: m.chips, without: m.without, load: p.load, save: p.save };
})();

/** The query parameters for the list route (the names are the server's: team_artifacts.go ListTeamArtifacts: q, kind, origin, by, kept, since, until, sort). Empty filters send nothing;
 *  sort is always sent, which makes it a query: the reply then carries the filtered total and a cursor for the next page. */
export function toParams(f) {
    const c = f && typeof f.team === 'string' ? INBOX.clean(f) : clean(f); // the Inbox's filters carry a team
    const p = {};
    if (c.q) p.q = c.q;
    if (c.team) p.team = c.team;
    if (c.kind) p.kind = c.kind;
    if (c.origin) p.origin = c.origin;
    if (c.by) p.by = c.by;
    if (c.kept) p.kept = 'true';
    if (c.tag) p.tag = c.tag;
    if (c.task) p.task = c.task;
    if (c.goal) p.goal = c.goal;
    if (c.from) p.since = localMidnight(c.from);
    if (c.to) p.until = localMidnight(c.to, 1);
    p.sort = c.sort;
    return p;
}
