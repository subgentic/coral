/* Coral's side of the shared Inbox (#5754): the adapter that gives inbox_panel.js its tasks, task text, reply and saved-message read from this Coral's own routes, and the one mounted panel
 * (the Inbox tab's "Tasks for you" and the "Read the whole message" control of a Saved for later item). The component itself is inbox_panel.js; Coral Hub mounts the same file with its own adapter. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { makeLinkPolicy } from './safe_markdown.js';
import { openTask, taskHref } from './task_navigation.js';
import { onAccountForgotten } from './local_store.js';
import { loadSafeMarkdown } from './vendor_loader.js';
import { keyLabel, pathId, serverFetch, boardFetch, identityKey, noteBoardLabels } from './server_base.js';
import { setInboxCount } from './inbox_tab.js'; // the count on the Tasks tab
const { mountInbox, clearInboxDrafts, INBOX_CONTRACT } = await importOnce('./inbox_panel.js'); // the component (shared with the hub); this file is the one that is Coral's

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
async function inboxRows(path, field) {
    const servers = ['local', ...new Set(state.hub ? (state.servers || []).filter(s => s.id && s.id !== 'local' && s.status === 'online').map(s => s.id) : [])];
    const results = await Promise.allSettled(servers.map(async server => {
        const data = await json(await serverFetch(server, path));
        const rows = Array.isArray(data[field]) ? data[field] : [];
        noteBoardLabels(rows, 'board_id', server);
        return rows.map(row => ({ ...row, board_id: identityKey(server, row.board_id) }));
    }));
    // Each source is ordered independently; merge by update time, not server order.
    const updated = row => { const time = Date.parse(row.updated_at); return Number.isFinite(time) ? time : -Infinity; };
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
        .sort((a, b) => updated(a) === updated(b) ? 0 : updated(b) - updated(a));
}

/** Open goals from this Coral and its registered machines, preserving team identity. */
export function listInboxGoals() { return inboxRows('/api/goals?limit=100', 'goals'); }

const ARTIFACT_LINK_RE = /coral:\/\/artifacts\/([0-9a-f]{64})(?![0-9a-f])/g;
const ARTIFACT_LOOKUPS_MAX = 20;

/** The link policy for ONE render of `text`: each distinct lowercase 64-hex artifact id in it (at most ARTIFACT_LOOKUPS_MAX, one request each) is asked for at GET /api/artifacts/<hex>/meta, and
 *  only an answer of exactly 200 makes it a link. 403, 404, any other status and a network failure leave it as text; no path is built from text without that 200. Nothing is kept between renders. */
export async function artifactLinkPolicy(text) {
    const ids = [...new Set([...String(text == null ? '' : text).matchAll(ARTIFACT_LINK_RE)].map(m => m[1]))].slice(0, ARTIFACT_LOOKUPS_MAX);
    const found = new Set();
    await Promise.all(ids.map(async hex => {
        try { if ((await fetch(`/api/artifacts/${hex}/meta`)).status === 200) found.add(hex); } catch { /* text */ }
    }));
    return makeLinkPolicy({ artifactExists: hex => found.has(hex) });
}

/** The adapter for this Coral (the Operator's own, on this computer). */
export const coralInboxAdapter = {
    contract: INBOX_CONTRACT,
    async listTasks() {
        const q = new URLSearchParams({ assigned_to: 'Operator', fields: FIELDS, sort: 'updated_at', order: 'desc', limit: '100' });
        for (const s of OPEN_STATUSES) q.append('status', s);
        const rows = await inboxRows(`/api/board/tasks?${q}`, 'tasks');
        return rows.map(t => ({ id: t.id, project: t.board_id, board: t.board_label || keyLabel(t.board_id), title: t.title, priority: t.priority, status: t.status,
            created_by: t.created_by, created_at: t.created_at, updated_at: t.updated_at, revision: t.revision, artifact_count: t.artifact_count,
            goal: t.goal_id && t.goal_title ? { id: Number(t.goal_id), title: String(t.goal_title) } : null })); // the goal it serves, when the route sends one (#7302)
    },
    openGoal(task) { return importOnce('./task_goals.js').then(m => m.openGoalOnTeamPage(task.project, task.goal.id)); },
    async getTask(project, id) {
        return json(await boardFetch(project, `/tasks/${pathId(id)}`));
    },
    async replyToTask({ project, taskId, content }) {
        const d = await json(await boardFetch(project, `/tasks/${pathId(taskId)}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }));
        return { ok: !!d.ok, notified: d.notified || [], warnings: d.warnings || [] };
    },
    async listTaskMessages(project, taskId) { // the task's conversation (#7703): the person's replies and the agents' answers posted with --task, oldest first
        const d = await json(await boardFetch(project, `/messages/all?task_id=${pathId(taskId)}&limit=200`));
        return (Array.isArray(d) ? d : []).map(m => ({ id: m.id, from: m.hub_user || m.subscriber_id || '', mine: m.subscriber_id === 'Operator' && !m.hub_user, content: m.content, created_at: m.created_at }));
    },
    canReply() { return { ok: true }; }, // the Operator of this computer; a Coral Hub viewer's adapter says why not
    async readSavedMessage(item) {
        // GET /api/saved/{id}/message (Backend, #5753): the redacted, capped text of the stored item's source; reason says why there is none (gone, not_reachable, too_long)
        const d = await json(await serverFetch(item.server, `/api/saved/${pathId(item.id)}/message`));
        return { text: typeof d.text === 'string' ? d.text : '', partial: !!d.partial, reason: typeof d.reason === 'string' ? d.reason : '' };
    },
    taskHref(task) { return taskHref(task.project, task.id); },
    openTask(task) { return openTask(task.project, task.id); },
    linkPolicy: makeLinkPolicy({}), // without a lookup, artifact links stay plain text
    // Before the text is drawn: the renderer is loaded on first use (a failed load leaves the text as plain text, renderSafe's own fallback), then the artifact lookups.
    async prepareLinks(text) { await loadSafeMarkdown().catch(() => {}); return artifactLinkPolicy(text); },
};

let _inbox = null;
onAccountForgotten(clearInboxDrafts);

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
export function savedExpandFor(item, which, mode) { const i = coralInbox(); return i ? i.savedExpand(item, which, mode) : null; }
