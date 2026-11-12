/* Kill Session from a row's menu, and Remove Agent for a sleeping or archived one (#15585): the confirmation and the kill. Lazy: agent_actions.js names it. */
import { state } from './state.js';
import { worktreeConfirmWords } from './worktree_words.js';
import { showWorktreeNotice } from './worktree_notice.js';
import { serverForSession } from './server_base.js';
import { killLiveSession, dropKilledRows } from './kill_live.js';
import { showToast, showView } from './utils.js';
import { showConfirmModal } from './confirm_dialog.js';
import { resolveSessionIdentity } from './session_state.js';
import { agentWords, whatStaysKill } from './agent_words.js';
import { KILL_LOG_NOTE } from './agent_actions.js';

export function killSessionDirect(name, agentType, sessionId) {
    const server = serverForSession(name, sessionId);
    const row = (state.liveSessions || []).find(s => s.session_id === sessionId);
    const who = agentWords(row, row ? resolveSessionIdentity(row) : name).label; // the agent by its role and team, not the folder it works in (#10139)
    const idle = row && (row.sleeping || row.archived), word = idle ? 'Remove' : 'Kill'; // nothing runs on such a row: it is only taken off the list, as its menu item says (#15585)
    showConfirmModal(idle ? 'Remove agent' : 'Kill session', `${word} ${who}? ${idle ? 'It is not running.' : 'This will terminate the agent.'} ${whatStaysKill([row || { agent_type: agentType }])} ${row && row.git_state && row.git_state.is_worktree ? worktreeConfirmWords(row.branch) + ' ' : ''}${KILL_LOG_NOTE}`, async () => { try {
        const result = await killLiveSession({ name, agent_type: agentType, session_id: sessionId }, server);
        if (!result) throw new Error('the kill answer was not JSON');
        if (result.error) { showToast(result.error, true); return; }
        if (result.changes_artifact_error) {
            showToast(`Killed, but changes.diff could not be saved: ${result.changes_artifact_error}`, true);
        } else {
            showToast(idle ? `Removed ${who}` : who + ' ended'); // 'ended' is the tag's wording (v2.0.65); the pick's older 'Killed and saved changes.diff: ...' is not used
        }
        showWorktreeNotice(result.worktree, 'agent'); // what became of its worktree, if it had one (#6707); a kept one stays on screen with its path (#6818)
        // The row goes at once: the agent's chat stays in History. A killed agent is not listed again.
        dropKilledRows([{ session_id: sessionId, server }]);
        if (state.currentSession && state.currentSession.session_id === sessionId) {
            state.currentSession = null;
            showView("welcome-screen");
        }
    } catch (e) {
        showToast("Failed to kill session", true);
    } }, undefined, { label: idle ? 'Remove agent' : 'Kill session', danger: true });
}
