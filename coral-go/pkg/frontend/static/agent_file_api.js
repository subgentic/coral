/* The selected agent's name and the query string its file routes take, shared by the file preview pane and the changed-files
 * list (#3794; both had the same two functions). */
import { state } from './state.js';

/** The selected live agent's name, or undefined. */
export function agentName() {
    return state.currentSession && state.currentSession.name;
}

// The Files panel follows an agent into the git worktree it works in (#11351); a person can send it back to the folder it was launched in. Per session, for as long as this page is open.
const launchOnly = new Set();

/** 'follow' (the default) or 'launch': which folder the file routes answer from for this session. */
export function worktreeMode(sessionId) { return sessionId && launchOnly.has(sessionId) ? 'launch' : 'follow'; }

export function setWorktreeMode(sessionId, mode) {
    if (!sessionId) return;
    if (mode === 'launch') launchOnly.add(sessionId); else launchOnly.delete(sessionId);
}

/** A query for the agent's file routes: the path, the session id when there is one, and which folder to answer from. */
export function apiQs(filepath) {
    const qs = new URLSearchParams({ filepath });
    const sid = state.currentSession && state.currentSession.session_id;
    if (sid) { qs.set('session_id', sid); qs.set('worktree', worktreeMode(sid)); }
    return qs;
}
