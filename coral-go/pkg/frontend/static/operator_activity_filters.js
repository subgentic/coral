/* The Inbox Activity folder's search and Filters (#12070, the Activity record #12064): what they are, how they are kept in the browser and how a row of the record is matched against them. Pure (no DOM), like
 * goal_filters.js, so it is tested on its own; inbox_toolbar.js draws the controls on the shared list bar and inbox_sidebar.js asks the rows. The rows are the ones GET /api/activity sends, so every field
 * here is one the rows already carry. */
import { defineFilters, localMidnight, text } from './filter_model.js';
import { browserLocal } from './safe_storage.js';

/** What the record holds, in the words the folder says, and the order the Action filter lists them. */
export const ACTION_LABEL = {
    proposal: 'Answered a proposal', goal_review: 'Reviewed a goal',
    skill_approve: 'Approved a skill', skill_reject: 'Rejected a skill', skill_remove: 'Removed a skill', skill_import: 'Imported a skill', skill_scripts_ack: 'Acknowledged skill scripts', skill_secret_ack: 'Acknowledged a skill secret',
    approve: 'Approved', changes: 'Asked for changes', deny: 'Denied', ignore: 'Dismissed', supersede: 'Superseded older version', unignore: 'Put back', save: 'Saved for later', unsave: 'Moved back to Needs you',
    undone: 'Undone (the agent could not be told)', answer: 'Answered', dismiss: 'Dismissed', goal_close: 'Closed a goal', mark_read: 'Marked read',
    send_review: 'Sent for review', unsend_review: 'Taken out of review',
    message: 'Sent a message', task_create: 'Created a task', task_complete: 'Completed a task', task_cancel: 'Cancelled a task', task_publish: 'Published a task', task_edit: 'Changed a task', task_remind: 'Reminded about a task',
    task_park: 'Parked or released a task', task_reply: 'Replied on a task', prompt_answer: "Answered an agent's prompt", prompt_allow: 'Allowed what an agent asked', prompt_reject: 'Refused what an agent asked', wait_dismiss: 'Dismissed a waiting agent', wait_send: 'Sent held words to an agent',
    mark_unread: 'Marked unread', file_tags: 'Changed the tags of a file', file_star: 'Starred a file', file_unstar: 'Unstarred a file', file_keep: 'Kept a file', file_release: 'Released a file', file_delete: 'Deleted a file', file_share: 'Shared a file with an agent', file_edit: 'Saved a new version of a file', file_edit_send: 'Sent an edit of a file to agents',
    saved_add: 'Saved a message', saved_update: 'Changed a saved message', saved_remove: 'Removed a saved message', chat_flag: 'Starred or archived a chat', chat_send: 'Sent words to an agent', run_seen: 'Opened or dismissed a failed run',
    agents_record: 'Recorded for all agents', goal_create: 'Created a goal', goal_edit: 'Changed a goal', goal_driver: 'Changed the driver of a goal', goal_move: 'Moved a goal to another team', goal_request_accept: 'Accepted a goal request',
    goal_request_decline: 'Declined a goal request', inbox_hide: 'Dismissed a row in Needs you',
    hub_update_check: 'Coral Hub checked for an update', hub_update_relaunch: 'Coral Hub relaunched into an update',
};
export const ACTIONS = Object.keys(ACTION_LABEL);
export const SORTS = ['newest', 'oldest'];
export const SORT_LABEL = { newest: 'Newest first', oldest: 'Oldest first' };

/** The team names by board id, for the team chip's words (an id the page does not know is shown as it is). */
let teamNames = new Map();
export function setTeamNames(map) { teamNames = map instanceof Map ? map : new Map(); }
const teamChip = v => `Team: ${teamNames.get(v) || v}`;

const model = defineFilters({
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    team: { type: 'custom', empty: '', clean: v => text(v, 200), filtered: v => !!v, chip: teamChip, clear: f => ({ ...f, team: '' }) },
    action: { type: 'choice', values: ACTIONS, chip: v => `Action: ${ACTION_LABEL[v]}` },
    from: { type: 'day', chip: v => `Since ${v}` },
    sort: { type: 'order', values: SORTS, default: 'newest' },
});
export const { EMPTY, clean, isFiltered, isQuery, chips, without } = model;

export const storageKey = () => 'coral-inbox-activity-filters';
const kept = model.persist(storageKey);
/** The filters kept in this browser for the folder, or the empty ones (the search words are not kept: a page opened later starts with an empty box). */
export const loadFilters = () => ({ ...kept.load('inbox-activity', browserLocal), q: '' });
export const saveFilters = f => kept.save('inbox-activity', { ...f, q: '' }, browserLocal);

const stamp = r => Date.parse(r.at || '') || 0;

/** Whether a row passes the filters. `teamOf(r)` is the words the Team column shows (the search covers them). */
export function matches(r, f, teamOf = x => x.team || '') {
    const c = clean(f);
    if (c.q) {
        const hay = [r.title, r.note, teamOf(r), ACTION_LABEL[r.action] || r.action, r.item_kind].join(' ').toLowerCase();
        if (!hay.includes(c.q.toLowerCase())) return false;
    }
    if (c.action && r.action !== c.action) return false;
    if (c.team && r.team !== c.team) return false;
    if (c.from && stamp(r) < Date.parse(localMidnight(c.from))) return false;
    return true;
}

/** The rows in the order the filters ask for (a new array). */
export function ordered(rows, f) {
    const c = clean(f);
    return [...rows].sort((a, b) => (c.sort === 'oldest' ? stamp(a) - stamp(b) || a.id - b.id : stamp(b) - stamp(a) || b.id - a.id));
}
