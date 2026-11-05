/* What the message board asks the server for (moved out of message_board.js, #5065; no behaviour change). */
import { state } from './state.js';
import { identityKey, noteBoardLabels, serverFetch, boardFetch, sessionServer, isCloud } from './server_base.js';

export const PAGE_SIZE = 50;

// Responses can arrive after a board switch or overlap another request; keep
// each message once, in id order.
export function mergeMessages(...lists) {
    const byId = new Map();
    for (const list of lists) for (const m of list) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
}

// Boards live on the server that hosts the team, so the project list is the
// hub's own boards plus those of every online remote. Each entry's `project`
// is a team key (server + name); local keys are the bare name.
/** The computers a scan of every team reads: the online ones this hub manages. */
const onlineRemotes = () => !state.hub ? [] : (state.servers || []).filter(s => s.id !== 'local' && s.status === 'online');
/** Which computers a scan would cover now: their ids, and a mark while the hub's list of them has not arrived. A scan that started under another key missed a computer (#13304). */
export const sourcesKey = () => onlineRemotes().map(s => s.id).sort().join(',') + (state.hub && !state.serversKnown ? '?' : '');

export async function fetchProjects() {
    const resp = isCloud() ? null : await fetch('/api/board/projects');
    const data = resp ? await resp.json() : [];
    const local = Array.isArray(data) ? data : [];
    noteBoardLabels(local, 'project'); // board_label beside each key (#3536)
    const remotes = onlineRemotes();
    const lists = await Promise.all(remotes.map(async srv => {
        try {
            const r = await serverFetch(srv.id, '/api/board/projects');
            if (!r.ok) return [];
            const rows = await r.json();
            noteBoardLabels(rows, 'project', srv.id);
            return (Array.isArray(rows) ? rows : []).map(p => ({ ...p, project: identityKey(srv.id, p.project), server: srv.id }));
        } catch { return []; }
    }));
    return [...local, ...lists.flat()];
}

/** fetchProjects for a choice that is saved over the whole list (#12144): every source that contributes (this computer's own boards, and each online computer it manages, in a hub or in the cloud) is checked, and one
 *  that cannot be read is an ERROR, not an empty list. fetchProjects turns a refusal into no teams, which is right for drawing a list and wrong for rewriting a saved choice from it. */
export async function fetchProjectsChecked() {
    const out = [];
    if (!isCloud()) {
        const resp = await serverFetch('local', '/api/board/projects'); // this computer's own boards
        const data = resp.ok ? await resp.json() : null;
        if (!Array.isArray(data)) throw new Error('this computer\'s boards could not be read');
        noteBoardLabels(data, 'project');
        out.push(...data);
    }
    const remotes = !state.hub ? [] : (state.servers || []).filter(s => s.id !== 'local' && s.status === 'online');
    for (const srv of remotes) {
        const r = await serverFetch(srv.id, '/api/board/projects');
        const rows = r.ok ? await r.json() : null;
        if (!Array.isArray(rows)) throw new Error('the boards of another computer could not be read');
        noteBoardLabels(rows, 'project', srv.id);
        out.push(...rows.map(p => ({ ...p, project: identityKey(srv.id, p.project), server: srv.id })));
    }
    return out;
}

// page is {before_id} or {after_id} (none: the latest page). A reply reports
// before_count, the messages older than the page.
export async function fetchMessages(project, limit = PAGE_SIZE, page = {}) {
    const params = new URLSearchParams({ limit: String(limit), format: 'dashboard' });
    for (const [k, v] of Object.entries(page)) params.set(k, String(v));
    if (!('offset' in page)) params.set('offset', '0');
    const resp = await boardFetch(project, `/messages/all?${params}`);
    // A refusal is not an empty board: a 503's {error} body once read as zero messages (#3430).
    if (!resp.ok) { const err = new Error(`messages: HTTP ${resp.status}`); err.resp = resp; throw err; }
    const data = await resp.json();
    return {
        messages: Array.isArray(data.messages) ? data.messages : [], total: Number(data.total) || 0,
        beforeCount: Number(data.before_count) || 0,
        askUpdates: Array.isArray(data.ask_updates) ? data.ask_updates : [], // the older questions a page after_id answers, with their state now (#8200)
    };
}

// The export reads whole boards and transcripts in pages (#3718): through Coral Hub a JSON reply
// is held whole to be checked for secrets and refused over 2 MiB, so it never asks for all of one
// at once.
const EXPORT_PAGE = 200;

const EXPORT_CHAT_PAGE = 100;

export async function fetchAllBoardMessages(project) {
    const first = await fetchMessages(project, EXPORT_PAGE);
    let all = first.messages;
    let before = first.beforeCount;
    while (before > 0 && all.length) {
        const r = await fetchMessages(project, EXPORT_PAGE, { before_id: all[0].id });
        if (!r.messages.length) break;
        all = mergeMessages(r.messages, all);
        before = r.beforeCount;
    }
    return all;
}

export async function fetchAllLiveChat(live) {
    const messages = [];
    for (let offset = 0; ; offset += EXPORT_CHAT_PAGE) {
        const params = new URLSearchParams({
            agent_type: live.agent_type || 'claude', session_id: live.session_id,
            working_directory: live.working_directory || '', after: '0',
            limit: String(EXPORT_CHAT_PAGE), offset: String(offset),
        });
        const resp = await serverFetch(sessionServer(live), `/api/sessions/live/${encodeURIComponent(live.name)}/chat?${params}`);
        if (!resp.ok) throw new Error(`chat: HTTP ${resp.status}`);
        const data = await resp.json();
        const page = Array.isArray(data.messages) ? data.messages : [];
        messages.unshift(...page);
        if (!page.length || messages.length >= data.total) break;
    }
    return { messages };
}

export async function fetchAllHistory(sessionId, server) { // server: the computer the session is on (the board's); a bare path through the Hub is the Hub's own (#12617)
    const messages = [];
    for (let offset = 0; ; offset += EXPORT_CHAT_PAGE) {
        const resp = await serverFetch(server, `/api/sessions/history/${encodeURIComponent(sessionId)}?limit=${EXPORT_CHAT_PAGE}&offset=${offset}`);
        if (!resp.ok) throw new Error(`history: HTTP ${resp.status}`);
        const data = await resp.json();
        const page = Array.isArray(data.messages) ? data.messages : [];
        messages.unshift(...page);
        if (!page.length || !data.start) break;
    }
    return { messages };
}

export async function fetchSubscribers(project) {
    const resp = await boardFetch(project, `/subscribers`);
    return await resp.json();
}

/** Review-only storage for files uploaded by agents without a team. Never add it to team choices. */
export async function fetchReviewProjects() {
    const projects = await fetchProjects();
    const sources = [...(isCloud() ? [] : ['local']), ...onlineRemotes().map(s => s.id)];
    const keys = new Set(projects.map(p => p.project));
    for (const server of sources) {
        const project = identityKey(server, '~no-team');
        if (!keys.has(project)) projects.push({ project, server });
    }
    return projects;
}
