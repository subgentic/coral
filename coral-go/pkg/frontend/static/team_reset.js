/* Reset team loads with its confirmation, outside the startup bundle. */
import { state } from './state.js';
import { teamFetch, keyLabel, inTeam } from './server_base.js';
import { showToast } from './utils.js';
import { showConfirmModal } from './confirm_dialog.js';
import { RESET_LOG_NOTE } from './agent_actions.js';
import { whatStaysReset } from './agent_words.js';
import { keepResetNote } from './codex_mode.js';

export function resetTeam(boardName) {
    document.dispatchEvent(new CustomEvent('coral:team-action', { detail: { team: boardName } }));
    showConfirmModal('Reset team', `Reset all agents in "${keyLabel(boardName)}"? Each one stops and starts again from its first instructions, in a new chat. ${whatStaysReset((state.liveSessions || []).filter(s => inTeam(s, boardName)))}${keepResetNote((state.liveSessions || []).filter(s => inTeam(s, boardName) && s.keep_full_access === true).length)} ${RESET_LOG_NOTE}`, async () => {
        try {
            const resp = await teamFetch(boardName, n => `/api/sessions/live/team/${encodeURIComponent(n)}/reset`, { method: 'POST' });
            if (resp.ok) {
                showToast(`Team "${keyLabel(boardName)}" is resetting...`);
            } else {
                const data = await resp.json().catch(() => ({}));
                showToast(data.error || 'Reset failed', true);
            }
        } catch {
            showToast('Reset failed', true);
        }
    }, undefined, { label: 'Reset team', danger: true });
}
