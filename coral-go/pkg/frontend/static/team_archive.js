/* Archive team and Restore team (#17491): a team is put away or brought back as one. Loaded when one is chosen, not at start. A team has no archive flag of its own: it is archived when every one of its agents is, so
   this is the per-agent archive (#3030) done for each member, with one question and one sentence back. Restore wakes nothing: each agent comes back asleep, as an Unarchive does. Goals, tasks, files and chats are untouched. */
import { state } from './state.js';
import { serverFetch, serverForSession, sessionServer, inTeam, keyLabel } from './server_base.js';
import { showToast } from './utils.js';
import { redrawLiveList } from './list_hooks.js';
import { showConfirmModal } from './confirm_dialog.js';

const members = (board, archived) => (state.liveSessions || []).filter(s => inTeam(s, board) && !!s.archived === archived);

async function each(board, action, list) {
    let done = 0;
    for (const s of list) {
        const server = serverForSession(s.name, s.session_id);
        try {
            const r = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(s.session_id)}/${action}`, { method: 'POST' });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) continue;
            const row = state.liveSessions.find(x => x.session_id === s.session_id && sessionServer(x) === server);
            if (row) { row.archived = !!d.archived; row.sleeping = !!d.sleeping; }
            done++;
        } catch { /* counted below: the toast says how many of the team were moved */ }
    }
    redrawLiveList();
    return done;
}

export function archiveTeam(board) {
    const list = members(board, false), name = keyLabel(board);
    if (!list.length) return Promise.resolve(false);
    return new Promise(resolve => showConfirmModal('Archive team',
        `Archive "${name}"? Its ${list.length === 1 ? 'agent stops' : `${list.length} agents stop`} now and ${list.length === 1 ? 'is' : 'are'} not woken by Wake All. Its goals, tasks, files and chats stay; Restore team brings the agents back, asleep.`,
        async () => { const n = await each(board, 'archive', list); showToast(n === list.length ? `Team "${name}" is archived. Restore team is under Archived in the sidebar.` : `Archived ${n} of ${list.length} agents of "${name}"`, n !== list.length); resolve(n > 0); },
        () => resolve(false), { danger: false, label: 'Archive team' }));
}

export async function restoreTeam(board) {
    const list = members(board, true), name = keyLabel(board);
    if (!list.length) return false;
    const n = await each(board, 'unarchive', list);
    showToast(n === list.length ? `Team "${name}" is back, asleep. Wake Team starts it.` : `Restored ${n} of ${list.length} agents of "${name}"`, n !== list.length);
    return n > 0;
}
