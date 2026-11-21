/* Complete board scans and paged exports load when requested, keeping reads off startup. */
import { fetchMessages, mergeMessages } from './board_fetch.js';
import { state } from './state.js';
import { isCloud, identityKey, noteBoardLabels, serverFetch, sessionServer, responseUpdateError } from './server_base.js';
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
        if (!resp.ok) throw (await responseUpdateError(resp, sessionServer(live))) || new Error(`chat: HTTP ${resp.status}`);
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
        if (!resp.ok) throw (await responseUpdateError(resp, server)) || new Error(`history: HTTP ${resp.status}`);
        const data = await resp.json();
        const page = Array.isArray(data.messages) ? data.messages : [];
        messages.unshift(...page);
        if (!page.length || !data.start) break;
    }
    return { messages };
}


export async function fetchProjects() {
    const resp = isCloud() ? null : await fetch('/api/board/projects');
    const data = resp ? await resp.json() : [];
    const local = Array.isArray(data) ? data : [];
    noteBoardLabels(local, 'project'); // board_label beside each key (#3536)
    const remotes = !state.hub ? [] : (state.servers || []).filter(s => s.id !== 'local' && s.status === 'online');
    const updates = [];
    const lists = await Promise.all(remotes.map(async srv => {
        try {
            const r = await serverFetch(srv.id, '/api/board/projects');
            if (!r.ok) { const update = await responseUpdateError(r, srv.id); if (update) updates.push(update.message); return []; }
            const rows = await r.json();
            noteBoardLabels(rows, 'project', srv.id);
            return (Array.isArray(rows) ? rows : []).map(p => ({ ...p, project: identityKey(srv.id, p.project), server: srv.id }));
        } catch { return []; }
    }));
    return Object.defineProperty([...local, ...lists.flat()], 'updates', { value: updates });
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
        if (!r.ok) { const update = await responseUpdateError(r, srv.id); if (update) throw update; }
        const rows = r.ok ? await r.json() : null;
        if (!Array.isArray(rows)) throw new Error('the boards of another computer could not be read');
        noteBoardLabels(rows, 'project', srv.id);
        out.push(...rows.map(p => ({ ...p, project: identityKey(srv.id, p.project), server: srv.id })));
    }
    return out;
}
