/* Which board and project the task views act on (moved out of tasks.js, #4996; no behaviour change). */
import { state } from './state.js';
import { sessionServer, identityKey } from './server_base.js';

// An agent that is not on a team board: tasks created for it are agent
// tasks (its own list in Coral), not board tasks.
export function _isSoloAgent() {
    if (state.selectedTeam) return false;
    return !!state.currentSession && state.currentSession.type === 'live' && !state.currentSession.board_project;
}

// Team key (server + board) of the selected agent; a solo agent uses its own name as the board.
export function _currentBoardKey() {
    const cs = state.currentSession;
    if (!cs) return null;
    const board = cs.board_project || cs.name;
    return board ? identityKey(sessionServer(cs), board) : null;
}

export function _getBoardProject() {
    if (state.selectedTeam) return state.selectedTeam;
    if (!state.currentSession) return null;
    return _currentBoardKey();
}

/** A worker's dock is scoped by the board's authoritative role and stable member ID.
 * The team page and orchestrator keep the board-wide list; a missing member identity shows no board tasks yet. */
export function agentTaskScope() {
 const s = state.currentSession;
 if (state.selectedTeam || !s || s.type !== 'live' || !s.board_project || s.board_is_orchestrator === true) return null;
 return { key: identityKey(sessionServer(s), s.session_id || s.name), assignee: s.board_subscriber_id || '' };
}

/** + Task in an agent's dock starts assigned to that agent, including the orchestrator. */
export function agentTaskAssignee() {
 const s = state.currentSession;
 return !state.selectedTeam && s?.type === 'live' && s.board_project ? s.board_subscriber_id || '' : '';
}
