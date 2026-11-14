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
    agents_record: 'Recorded for all agents', keep_full_access: 'Changed Full access on restart', goal_create: 'Created a goal', goal_edit: 'Changed a goal', goal_driver: 'Changed the driver of a goal', goal_move: 'Moved a goal to another team', goal_request_accept: 'Accepted a goal request',
    goal_request_decline: 'Declined a goal request', inbox_hide: 'Dismissed a row in Needs you', preview_trust: 'Trusted a file to run scripts in its preview', preview_untrust: 'Turned scripts off in a file preview',
    hub_update_check: 'Coral Hub checked for an update', hub_update_relaunch: 'Coral Hub relaunched into an update',
};
export const DECISION_LABEL = { approve: 'Approved', changes: 'Asked for changes', deny: 'Denied', answer: 'Answered', dismiss: 'Dismissed' };
export const DECISIONS = Object.keys(DECISION_LABEL);
export const decisionOf = row => ({ ignore: 'dismiss', wait_dismiss: 'dismiss', inbox_hide: 'dismiss', prompt_answer: 'answer', prompt_allow: 'approve', prompt_reject: 'deny', skill_approve: 'approve', skill_reject: 'deny' }[row.action] || (DECISIONS.includes(row.action) ? row.action : ''));

/** The kinds of action the folder's chips show (#15724, the Operator's pick of design B): the page opens on Everything, and a chip narrows the record to one kind. The full record stays one chip away. */
export const KINDS = ['decisions', 'answers', 'permissions', 'files', 'words'];
export const KIND_LABEL = { decisions: 'Decisions', answers: 'Answers', permissions: 'Permissions', files: 'Files and tasks', words: 'Words sent' };
/** An answer to a dialog about trusting something (Codex's "Trust all and continue", a folder trust): the row keeps only the option's words, so the words decide. */
export const isTrustAnswer = r => r.action === 'prompt_answer' && (r.title === 'Trust dialog' || /\btrust/i.test(String(r.note || ''))); // a newer row says it answered a trust dialog (title, whichever option: 'No, quit' too, #16129); an older one is told by its note's words
const KIND_TEST = {
    decisions: r => !!DECISION_LABEL[decisionOf(r)] || ['goal_close', 'task_complete', 'task_cancel', 'goal_review'].includes(r.action), // Answered, Allowed, Denied, Approved, Closed, Completed and the like
    answers: r => r.action === 'answer' || r.action === 'proposal' || r.action === 'prompt_answer', // an agent's question answered (#16088)
    permissions: r => r.action === 'prompt_allow' || r.action === 'prompt_reject' || isTrustAnswer(r), // a request to use a tool, allowed or refused (#16088); a trust dialog's answer is a permission decision too, so it is in both lists (#16116)
    files: r => ['file', 'task', 'goal'].includes(r.item_kind) && r.action !== 'chat_send',
    words: r => ['message', 'chat_send', 'task_reply'].includes(r.action),
};
export const inKind = (r, k) => !k || !!(KIND_TEST[k] && KIND_TEST[k](r));

export const NO_GOAL = 'No goal';
/** The agent a row is about, when the record says (#14445): who asked, for an ask (an older answer kept the asker as its title), or the agent named by a prompt, wait or chat row; '' for a row about no agent. */
export const agentOf = row => String(row.asker || ((row.item_kind === 'agent' || /^(prompt_|wait_)/.test(row.action || '') || (row.action === 'answer' && row.item_kind === 'question')) ? ((row.action === 'prompt_answer' ? row.item_id : row.title) || (row.item_kind === 'agent' ? row.item_id : '')) : '') || '').trim();
/** The goal a row served: its title (the server looks it up now), else its number, else the words for none; a row from before the record kept goals has none. */
export const goalOf = row => (row.goal_title ? String(row.goal_title).trim() : Number(row.goal_id) > 0 ? `Goal #${Number(row.goal_id)}` : NO_GOAL);
export const ACTIONS = Object.keys(ACTION_LABEL);
export const SORTS = ['newest', 'oldest'];
export const SORT_LABEL = { newest: 'Newest first', oldest: 'Oldest first' };

/** The team names by board id, for the team chip's words (an id the page does not know is shown as it is). */
let teamNames = new Map();
export function setTeamNames(map) { teamNames = map instanceof Map ? map : new Map(); }
const teamChip = v => `Team: ${teamNames.get(v) || v}`;
/** The computers' names by the Hub's own id for them, for the Computer chip (#15730); an id the page does not know is shown as it is. */
let serverNames = new Map();
export function setServerNames(map) { serverNames = map instanceof Map ? map : new Map(); }

const model = defineFilters({
    q: { type: 'text', max: 200, chip: v => `Search: ${v}` },
    team: { type: 'custom', empty: '', clean: v => text(v, 200), filtered: v => !!v, chip: teamChip, clear: f => ({ ...f, team: '' }) },
    server: { type: 'text', max: 200, chip: v => `Computer: ${serverNames.get(v) || v}` }, // which computer's record a row came from (a Hub-served dashboard reads several, #15730)
    agent: { type: 'text', max: 80, chip: v => `Agent: ${v}` },
    goal: { type: 'text', max: 200, chip: v => `Goal: ${v}` }, // the goal a row served, or "No goal", as Needs you says it (#14445)
    kind: { type: 'choice', values: KINDS, chip: v => `Kind: ${KIND_LABEL[v]}` },
    decision: { type: 'choice', values: DECISIONS, chip: v => `Decision: ${DECISION_LABEL[v]}` },
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
        const hay = [r.title, r.note, r.asker, r.goal_title, r.task_title, DECISION_LABEL[decisionOf(r)], teamOf(r), ACTION_LABEL[r.action] || r.action, r.item_kind].join(' ').toLowerCase();
        if (!hay.includes(c.q.toLowerCase())) return false;
    }
    if (c.kind && !inKind(r, c.kind)) return false;
    if (c.decision && decisionOf(r) !== c.decision) return false;
    if (c.agent && agentOf(r) !== c.agent) return false;
    if (c.goal && goalOf(r) !== c.goal) return false;
    if (c.action && r.action !== c.action) return false;
    if (c.team && r.team !== c.team) return false;
    if (c.server && (r.server || 'local') !== c.server) return false;
    if (c.from && stamp(r) < Date.parse(localMidnight(c.from))) return false;
    return true;
}

/** The rows in the order the filters ask for (a new array). */
export function ordered(rows, f) {
    const c = clean(f);
    return [...rows].sort((a, b) => (c.sort === 'oldest' ? stamp(a) - stamp(b) || a.id - b.id : stamp(b) - stamp(a) || b.id - a.id));
}
