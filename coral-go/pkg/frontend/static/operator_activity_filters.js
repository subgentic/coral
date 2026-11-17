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
    task_park: 'Parked or released a task', task_reply: 'Replied on a task', prompt_answer: "Answered an agent's question", prompt_allow: 'Allowed what an agent asked', prompt_reject: 'Refused what an agent asked', wait_dismiss: 'Dismissed a waiting agent', wait_send: 'Sent held words to an agent',
    mark_unread: 'Marked unread', file_tags: 'Changed the tags of a file', file_comment: 'Commented on a file', file_reply: 'An agent replied on a file', file_review: 'An agent asked for a review of a file', file_version: 'An agent saved a new version of a file', file_star: 'Starred a file', file_unstar: 'Unstarred a file', file_keep: 'Kept a file', file_release: 'Released a file', file_delete: 'Deleted a file', file_share: 'Shared a file with an agent', file_edit: 'Saved a new version of a file', file_edit_send: 'Sent an edit of a file to agents',
    saved_add: 'Saved a message', saved_update: 'Changed a saved message', saved_remove: 'Removed a saved message', chat_flag: 'Starred or archived a chat', chat_send: 'Sent words to an agent', /* recorded, never shown as a row (#18466); the census wants a word for every recorded action */ run_seen: 'Opened or dismissed a failed run',
    agents_record: 'Recorded for all agents', keep_full_access: 'Changed Full access on restart', goal_create: 'Created a goal', goal_edit: 'Changed a goal', goal_driver: 'Changed the driver of a goal', goal_move: 'Moved a goal to another team', goal_request_accept: 'Accepted a goal request',
    goal_request_decline: 'Declined a goal request', inbox_hide: 'Dismissed a row in Needs you', agent_sleep: 'Put an agent to sleep', agent_wake: 'Woke an agent', setting_change: 'Changed settings', preview_trust: 'Trusted a file to run scripts in its preview', preview_untrust: 'Turned scripts off in a file preview',
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
    files: r => ['file', 'task', 'goal'].includes(r.item_kind),
    words: r => ['message', 'task_reply'].includes(r.action),
};
/** The kinds a value stands for, in the chips' order and with none twice: an array of them, or one (what an earlier version kept in the browser); anything else is none, which is Everything. */
export const kindsOf = v => { const a = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []; return KINDS.filter(k => a.includes(k)); };
/** Whether a row is of a kind, or of any of several (an empty list or '' is every row). */
export const inKind = (r, k) => { const ks = kindsOf(k); return !ks.length || ks.some(x => KIND_TEST[x](r)); };

/** Delivery bookkeeping, not something a person did or must act on (#19149): the Important view leaves these rows out and Everything shows them. */
export const NOISE_ACTIONS = ['wait_send', 'hub_update_check', 'mark_read', 'mark_unread', 'agents_record'];
/** Whether a row is left out by the Important view: the one rule the rows and the counts both use. */
export const isNoise = r => NOISE_ACTIONS.includes(r.action);
export const passesImportant = (r, f) => !(f && f.important === true && isNoise(r));

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
    important: { type: 'custom', empty: false, clean: v => v === true, filtered: v => v === true, clear: f => ({ ...f, important: false }) }, // the Important view (#19149): no chip repeats it, the pill is its control
    kind: { type: 'custom', empty: [], clean: v => kindsOf(v), filtered: v => kindsOf(v).length > 0, clear: f => ({ ...f, kind: [] }) }, // the chips of the toolbar are these (several at once); no filter chip repeats them over the strip (#16087)
    decision: { type: 'choice', values: DECISIONS, chip: v => `Decision: ${DECISION_LABEL[v]}` },
    action: { type: 'choice', values: ACTIONS, chip: v => `Action: ${ACTION_LABEL[v]}` },
    from: { type: 'day', chip: v => `Since ${v}` },
    sort: { type: 'order', values: SORTS, default: 'newest' },
});
export const { EMPTY, clean, isFiltered, isQuery, chips, without } = model;

export const storageKey = () => 'coral-inbox-activity-filters';
const kept = model.persist(storageKey);
/** The filters kept in this browser for the folder, or the empty ones (the search words are not kept: a page opened later starts with an empty box). */
/** A browser that kept nothing opens on Important (#19149); one that kept a choice (including the earlier "everything") keeps it: a kept record without the Important field is Everything. */
export const loadFilters = () => {
    let raw = null;
    try { raw = browserLocal.get(storageKey('inbox-activity')); } catch { raw = null; }
    return raw == null ? { ...EMPTY, important: true } : { ...kept.load('inbox-activity', browserLocal), q: '' };
};
/** Kept always, Everything too: removing the record would bring Important back on the next page. */
export const saveFilters = f => { try { browserLocal.set(storageKey('inbox-activity'), JSON.stringify({ ...clean(f), q: '' })); } catch { /* storage unavailable: the choice lasts until the page is closed */ } };

const stamp = r => Date.parse(r.at || '') || 0;

/** Whether a row passes the filters. `teamOf(r)` is the words the Team column shows (the search covers them). */
export function matches(r, f, teamOf = x => x.team || '') {
    const c = clean(f);
    if (c.q) {
        const hay = [r.title, r.note, r.asker, r.goal_title, r.task_title, DECISION_LABEL[decisionOf(r)], teamOf(r), ACTION_LABEL[r.action] || r.action, r.item_kind].join(' ').toLowerCase();
        if (!hay.includes(c.q.toLowerCase())) return false;
    }
    if (!passesImportant(r, c)) return false;
    if (!inKind(r, c.kind)) return false;
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
