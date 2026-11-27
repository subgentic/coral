/* Archive team and Restore team (#17491, #21850): a team is put away or brought back as one. Loaded when one is chosen, not at start. The server does it (POST and DELETE /api/board/<team>/archive): every awake agent
   is put to sleep and archived, the board is marked archived and paused, and nothing is deleted. An archived team is nowhere in the sidebar (render.js leaves out rows with team_archived); it is listed under
   Archived teams on the Teams page, where Restore team is. Restore wakes nothing: each agent comes back asleep. */
import { state } from './state.js';
import { boardFetch, inTeam, keyLabel } from './server_base.js';
import { showToast } from './utils.js';
import { redrawLiveList } from './list_hooks.js';
import { showConfirmModal } from './confirm_dialog.js';
import { applySleepingView } from './sleeping_view.js';
import { importOnce } from './import_once.js';
const { setArchived } = await importOnce('./archived_teams.js');

const members = board => (state.liveSessions || []).filter(s => inTeam(s, board));

/** The Archive team question (#21850's mock): what stops, what stays, how to bring it back. */
export function archiveWords(name, awake, total) {
    const agents = n => `${n} agent${n === 1 ? '' : 's'}`;
    return [`Archive "${name}"?`,
        awake ? `Puts its ${awake === 1 ? 'agent' : agents(awake)} to sleep, then archives ${total === 1 ? 'it' : 'everything'}. Wake All skips ${total === 1 ? 'it' : 'them'}.` : 'No agent of this team is running, so nothing is stopped.',
        'Stays: everything. The board and its messages, goals, tasks, artifacts, chats and History.',
        'Bring it back: Restore team, on the Teams page under Archived teams. It leaves the sidebar now. Agents come back asleep; Wake team starts them.'].join('\n');
}

function followRows(board, archived) {
    const cur = state.currentSession, was = cur && cur.type === 'live' ? cur.session_id : '';
    for (const s of members(board)) { s.team_archived = archived; s.archived = archived; s.sleeping = true; }
    redrawLiveList();
    const row = was && members(board).find(s => s.session_id === was);
    if (row) applySleepingView(true, { archived, manageInput: !document.body.classList.contains('popout-mode') }); // the chat on screen follows now, not on the next feed tick
    setArchived(board, archived, new Date().toISOString()); // the Teams page and a team page open on it redraw (coral:team-archived-changed)
}

export function archiveTeam(board) {
    const list = members(board), awake = list.filter(s => !s.sleeping && !s.archived).length, name = keyLabel(board);
    return new Promise(resolve => {
        showConfirmModal('Archive team', archiveWords(name, awake, list.length), async () => {
            try {
                const r = await boardFetch(board, '/archive', { method: 'POST' }), d = await r.json().catch(() => ({}));
                if (!r.ok || !d.ok) { showToast(d.error || `Team "${name}" was not archived.`, true); resolve(false); return; }
                followRows(board, true);
                showToast(`Team "${name}" is archived. Restore team is on the Teams page, under Archived teams.`);
                resolve(true);
            } catch { showToast('Could not reach Coral to archive the team.', true); resolve(false); }
        }, () => resolve(false), { danger: false, label: 'Archive team' });
        const m = document.getElementById('confirm-modal-message'); if (m) m.replaceChildren(...archiveWords(name, awake, list.length).split('\n').flatMap((l, i) => (i ? [document.createElement('br'), l] : [l]))); // short lines, one under another
    });
}

export async function restoreTeam(board) {
    const name = keyLabel(board);
    try {
        const r = await boardFetch(board, '/archive', { method: 'DELETE' }), d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { showToast(d.error || `Team "${name}" was not restored.`, true); return false; }
        for (const s of members(board)) { s.team_archived = false; s.archived = false; s.sleeping = true; }
        followRows(board, false); // the live feed's next tick brings the rows back to the sidebar
        showToast(`Team "${name}" is back, asleep. Wake team starts it.`);
        return true;
    } catch { showToast('Could not reach Coral to restore the team.', true); return false; }
}
export { archiveTeam as archive, restoreTeam as restore }; // team_actions.js calls them by the menu's own word
