/* Stop Session from a row's menu, and Remove Agent for a sleeping or archived one (#15585): the confirmation and the kill. Lazy: agent_actions.js names it. */
import { state } from './state.js';
import { worktreeConfirmWords } from './worktree_words.js';
import { showWorktreeNotice } from './worktree_notice.js';
import { serverForSession } from './server_base.js';
import { killLiveSession, dropKilledRows } from './kill_live.js';
import { showToast, showView } from './utils.js';
import { showConfirmModal } from './confirm_dialog.js';
import { resolveSessionIdentity } from './session_state.js';
import { agentWords, whatStaysKill } from './agent_words.js';
import { KILL_LOG_NOTE, toggleAgentSleep, toggleAgentArchive } from './agent_actions.js';

export function killSessionDirect(name, agentType, sessionId) {
    const server = serverForSession(name, sessionId);
    const row = (state.liveSessions || []).find(s => s.session_id === sessionId);
    const who = agentWords(row, row ? resolveSessionIdentity(row) : name).label; // the agent by its role and team, not the folder it works in (#10139)
    if (row && row.board_project && row.agent_type !== 'terminal' && !row.archived) return stopTeamAgent(row, who, name, sessionId); // a team agent: Stop archives it (#19674)
    const idle = row && (row.sleeping || row.archived), gone = row && row.archived, word = gone ? 'Remove' : 'Stop'; // nothing runs on such a row: an archived one is only taken off the list, as its menu item says (#15585); a sleeping one's menu says Stop agent (#19674)
    showConfirmModal(gone ? 'Remove agent' : 'Stop agent', `${word} ${who}? ${idle ? 'It is not running.' : "This ends the agent's process."} ${whatStaysKill([row || { agent_type: agentType }])} ${row && row.git_state && row.git_state.is_worktree ? worktreeConfirmWords(row.branch) + ' ' : ''}${KILL_LOG_NOTE}`, async () => { try {
        const result = await killLiveSession({ name, agent_type: agentType, session_id: sessionId }, server);
        if (!result) throw new Error('the kill answer was not JSON');
        if (result.error) { showToast(result.error, true); return; }
        if (result.changes_artifact_error) {
            showToast(`Stopped, but changes.diff could not be saved: ${result.changes_artifact_error}`, true);
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
        showToast("Failed to stop agent", true);
    } }, undefined, { label: gone ? 'Remove agent' : 'Stop agent', danger: true });
}

// Start and Sleep on an archived agent's page (#19674): Start is the sidebar's Wake (back awake), Sleep its Unarchive (stays asleep, back in the list). Here, a lazy module of agent actions.
/** The two buttons, in order; done() runs after the server applied the change. */
export function archivedButtons(agent, session, done) {
    const make = (cls, word, act) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = word; b.setAttribute('aria-label', `${word} ${agent.name}`);
        b.addEventListener('click', async () => {
            if (await act()) done();
        });
        return b;
    };
    return [
        make('btn btn-primary', 'Start', () => toggleAgentSleep(session.name, session.agent_type, session.session_id, 'wake')),
        make('btn', 'Sleep', () => toggleAgentArchive(session.name, session.agent_type, session.session_id, 'unarchive')),
    ];
}

/** Stop on a team agent, awake or asleep (#19674): ends its session and archives it. It leaves the Agents list, stays on the team, and Start brings it back. */
function stopTeamAgent(row, who, name, sessionId) {
    if (row.own_worktree) { toggleAgentArchive(name, row.agent_type, sessionId, 'archive'); return; } // a worker in its own worktree: the Archive dialog with its tick box (#21468)
    showConfirmModal('Stop agent', `Stop ${who}? It ends the agent's session and archives it: it leaves the Agents list and can be started again from More > Archived. Its chat stays in History.`,
        () => toggleAgentArchive(name, row.agent_type, sessionId, 'archive', true), undefined, { label: 'Stop agent', danger: true });
}
