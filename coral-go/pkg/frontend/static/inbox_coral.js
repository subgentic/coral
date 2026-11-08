/* Coral's side of the shared Inbox (#5754): the adapter that gives inbox_panel.js its tasks, task text, reply and saved-message read from this Coral's own routes, and the one mounted panel
 * (the Inbox tab's "Tasks for you" and the "Read the whole message" control of a Saved for later item). The component itself is inbox_panel.js; Coral Hub mounts the same file with its own adapter. */
import { nativeSavedSourceAllowed } from './server_status.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { makeLinkPolicy } from './safe_markdown.js';
import { openTask, taskHref } from './task_navigation.js';
import { cleanArtifactName } from './artifact_names.js';
import { onAccountForgotten } from './local_store.js';
import { loadSafeMarkdown } from './vendor_loader.js';
import { keyLabel, splitKey, pathId, serverFetch, boardFetch, identityKey, noteBoardLabels, isCloud, savedExpandOn, personalInboxSources, personalInboxAllowed, inboxReplyOn, nativeTasks } from './server_base.js';
import { setInboxCount } from './inbox_tab.js'; // the count on the Tasks tab
const { mountInbox, clearInboxDrafts, INBOX_CONTRACT } = await importOnce('./inbox_panel.js'); // the component (shared with the hub); this file is the one that is Coral's

const replyContexts = new Map();
const rememberReply = (project, task) => {
    const key = `${project}#${task.id}`;
    replyContexts.set(key, { project, status: task.status, parked_reason: task.parked_reason, parked_until: task.parked_until });
    if (replyContexts.size > 1000) replyContexts.delete(replyContexts.keys().next().value);
};

const OPEN_STATUSES = ['pending', 'in_progress', 'review_pending', 'blocked'];
const FIELDS = 'id,board_id,board_label,title,priority,status,created_by,created_at,updated_at,revision,goal_id,goal_title,artifact_count'; // updated_at and revision are the change stamp the panel keeps a drawn task by (#5803)

async function json(resp) {
    let data = {};
    try { data = await resp.json(); } catch { /* no body */ }
    if (!resp.ok) throw new Error((data && typeof data.error === 'string' && data.error) || `HTTP ${resp.status}`);
    return data;
}

/** The local Inbox spans the same online registered machines as Saved and Board history.
 * IDs are only unique on their source machine; qualify the team before any row is opened. */
async function inboxRows(path, field, personal = false) {
    const servers = personal && isCloud() ? personalInboxSources().filter(s => personalInboxAllowed(s.id)).map(s => s.id) : [...(isCloud() ? [] : ['local']), ...new Set(state.hub ? (state.servers || []).filter(s => s.id && s.id !== 'local' && s.status === 'online').map(s => s.id) : [])];
    const results = await Promise.allSettled(servers.map(async server => {
        const data = await json(await serverFetch(server, path));
        if (personal && !Array.isArray(data[field])) throw new Error('The task list was not usable.');
        const rows = Array.isArray(data[field]) ? (personal ? data[field].slice(0, 100) : data[field]) : [];
        noteBoardLabels(rows, 'board_id', server);
        return rows.filter(row => !personal || (validTask(row) && personalInboxAllowed(server))).map(row => ({ ...row, server, board_id: identityKey(server, row.board_id) }));
    }));
    inboxRows.failed = results.some(result => result.status === 'rejected'); // a read that failed or was refused is told to the caller, which backs off (#13389)
    // Each source is ordered independently; merge by update time, not server order.
    const updated = row => { const time = Date.parse(row.updated_at); return Number.isFinite(time) ? time : -Infinity; };
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
        .sort((a, b) => updated(a) === updated(b) ? 0 : updated(b) - updated(a));
}

/** Open goals from this Coral and its registered machines, preserving team identity. */
let goalsFailed = false, doneCapped = false;
const DONE_PAGE = 100;
/** Whether a computer sent a whole page of finished goals: there may be newer ones that are not listed (#14613); the Done list then says it shows the first ones. */
export const doneGoalsCapped = () => doneCapped;
export const goalsReadFailed = () => goalsFailed;
/** ONE read of the goals per call, as Security's conditions on the goals reader pin (#13389: one request in flight, one per gap): the open goals, or, with `finished`, the goals that are done (state=done, the first DONE_PAGE a computer sends, oldest first). The Goals folder asks for the finished ones only while its Done pill is picked (#14601, #14641: a second read on every gap broke the one-read-per-gap rule and the Hub's query census). */
export async function listInboxGoals(finished = false) {
    const rows = await inboxRows(finished ? '/api/goals?state=done&limit=' + DONE_PAGE : '/api/goals?limit=100', 'goals');
    goalsFailed = !!inboxRows.failed;
    if (finished) doneCapped = Object.values(rows.reduce((n, d) => (n[d.server] = (n[d.server] || 0) + 1, n), {})).some(n => n >= DONE_PAGE);
    return rows;
}

const validTask = row => row && Number.isSafeInteger(row.id) && row.id > 0 && typeof row.board_id === 'string' && !!row.board_id.trim() && [...row.board_id].length <= 200 && !/[\u0000-\u001f\u007f-\u009f/\\%?#]/.test(row.board_id) && !row.board_id.includes('..') && !row.board_id.startsWith('.');
let taskReadFailed = false, tasksCapped = false;
export const taskReadState = () => ({ failed: taskReadFailed, capped: tasksCapped });

const ARTIFACT_LINK_RE = /coral:\/\/artifacts\/([0-9a-f]{64})(?![0-9a-f])/g;
const ARTIFACT_LOOKUPS_MAX = 20;

/** The link policy for ONE render of `text`: each distinct lowercase 64-hex artifact id in it (at most ARTIFACT_LOOKUPS_MAX, one request each) is asked for at GET /api/artifacts/<hex>/meta, and
 *  only an answer of exactly 200 makes it a link. 403, 404, any other status and a network failure leave it as text; no path is built from text without that 200. Nothing is kept between renders. */
export async function artifactLinkPolicy(text, server) { // server: the one the text is from; through the Hub a bare /api path is the Hub's own (#12581)
    const ids = [...new Set([...String(text == null ? '' : text).matchAll(ARTIFACT_LINK_RE)].map(m => m[1]))].slice(0, ARTIFACT_LOOKUPS_MAX);
    const found = new Map(); // hex -> the name it was stored under ('' when none), for the link's text (#297)
    await Promise.all(ids.map(async hex => {
        try {
            const r = await serverFetch(server, `/api/artifacts/${hex}/meta`);
            if (r.status !== 200) return;
            let name = '';
            try { name = cleanArtifactName((await r.json()).name); } catch { /* no body: the short id */ }
            found.set(hex, name);
        } catch { /* text */ }
    }));
    return makeLinkPolicy({ artifactExists: hex => found.has(hex), artifactName: hex => found.get(hex) || '' });
}

/** The adapter for this Coral (the Operator's own, on this computer). */
export const coralInboxAdapter = {
    contract: INBOX_CONTRACT,
    async listTasks() {
        const hub = isCloud() && nativeTasks();
        const q = new URLSearchParams({ ...(hub ? {} : { assigned_to: 'Operator' }), fields: FIELDS + (hub ? ',assigned_to,parked_reason,parked_until' : ''), sort: 'updated_at', order: 'desc', limit: '100' });
        for (const s of [...OPEN_STATUSES, ...(hub ? ['draft'] : [])]) q.append('status', s);
        let rows = await inboxRows(`/api/board/tasks?${q}`, 'tasks', hub);
        taskReadFailed = !!inboxRows.failed;
        tasksCapped = Object.values(rows.reduce((out, row) => (out[row.server] = (out[row.server] || 0) + 1, out), {})).some(n => n >= 100);
        if (hub) rows = rows.filter(t => String(t.assigned_to || '').replace(/^@/, '').toLowerCase() === 'operator' || t.status === 'review_pending');
        for (const task of rows) if (hub) rememberReply(task.board_id, task);
        return rows.map(t => ({ id: t.id, server: t.server, project: t.board_id, board: t.board_label || keyLabel(t.board_id), title: t.title, priority: t.priority, status: t.status,
            assigned_to: t.assigned_to, parked_reason: t.parked_reason, parked_until: t.parked_until, created_by: t.created_by, created_at: t.created_at, updated_at: t.updated_at, revision: t.revision, artifact_count: t.artifact_count,
            goal: Number.isSafeInteger(Number(t.goal_id)) && Number(t.goal_id) > 0 && t.goal_title ? { id: Number(t.goal_id), title: String(t.goal_title) } : null })); // the goal it serves, when the route sends one (#7302)
    },
    openGoal(task) { return importOnce('./task_goals.js').then(m => m.openGoalOnTeamPage(task.project, task.goal.id)); },
    async getTask(project, id) {
        const task = await json(await boardFetch(project, `/tasks/${pathId(id)}`));
        if (isCloud()) rememberReply(project, { ...task, id: pathId(id) });
        return task;
    },
    async replyToTask({ project, taskId, content, replyTo }) {
        if (isCloud() && (!replyContexts.has(`${project}#${taskId}`) || !this.canReply(replyContexts.get(`${project}#${taskId}`)).ok)) throw new Error('Reply is not available for this computer.');
        const d = await json(await boardFetch(project, `/tasks/${pathId(taskId)}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, ...(Number(replyTo) > 0 ? { reply_to: Number(replyTo) } : {}) }) }));
        return { ok: !!d.ok, notified: d.notified || [], warnings: d.warnings || [] };
    },
    async listTaskMessages(project, taskId) { // the task's conversation (#7703): the person's replies and the agents' answers posted with --task, oldest first
        const d = await json(await boardFetch(project, `/messages/all?task_id=${pathId(taskId)}&limit=200`));
        return (Array.isArray(d) ? d : []).map(m => ({ id: m.id, from: m.hub_user || m.subscriber_id || '', mine: m.subscriber_id === 'Operator' && !m.hub_user, content: m.content, created_at: m.created_at }));
    },
    canReply(task) { return !isCloud() || (inboxReplyOn() && personalInboxAllowed(splitKey(task?.project).server, true) && ['pending', 'in_progress', 'blocked', 'draft'].includes(task?.status) && !task?.parked_reason && !task?.parked_until) ? { ok: true } : { ok: false, reason: 'Reply requires an owned computer in Interact or Launch mode and an available task.' }; }, // the Operator of this computer; a Coral Hub viewer's adapter says why not
    async readSavedMessage(item) {
        // GET /api/saved/{id}/message (Backend, #5753): the redacted, capped text of the stored item's source; reason says why there is none (gone, not_reachable, too_long)
        if (isCloud() && (!savedExpandOn() || !nativeSavedSourceAllowed(item.server))) throw new Error('This saved message is not available.');
        const d = await json(await serverFetch(item.server, `/api/saved/${pathId(item.id)}/message`));
        if (isCloud() && !nativeSavedSourceAllowed(item.server)) throw new Error('This saved message is no longer available.');
        return { text: typeof d.text === 'string' ? d.text : '', partial: !!d.partial, reason: typeof d.reason === 'string' ? d.reason : '' };
    },
    taskHref(task) { return taskHref(task.project, task.id); },
    openTask(task) { return openTask(task.project, task.id); },
    linkPolicy: makeLinkPolicy({}), // without a lookup, artifact links stay plain text
    // Before the text is drawn: the renderer is loaded on first use (a failed load leaves the text as plain text, renderSafe's own fallback), then the artifact lookups.
    async prepareLinks(text, server, project) { await loadSafeMarkdown().catch(() => {}); return artifactLinkPolicy(text, server || (project ? splitKey(project).server : undefined)); }, // a task opened from a team's page has its team key, not a server field
};

let _inbox = null;
onAccountForgotten(() => { clearInboxDrafts(); replyContexts.clear(); });

/** The mounted panel (made the first time it is asked for, in the Inbox tab's Tasks panel), or null where the page has no such host. */
function coralInbox() {
    if (_inbox) return _inbox;
    const host = document.getElementById('inbox-tasks-host');
    if (!host) return null;
    _inbox = mountInbox(host, coralInboxAdapter, { load: false, region: false, onCount: (n, high) => setInboxCount('tasks', n, high) });
    return _inbox;
}

/** Read the tasks again (the Tasks tab was opened). */
export function refreshTasks() { const i = coralInbox(); if (i) i.refresh(); }

/** The "Read the whole message" control for a saved item, or null. */
export function savedExpandFor(item, which, mode) { if (!savedExpandOn()) return null; const i = coralInbox(); return i ? i.savedExpand(item, which, mode) : null; }
