/* The one kill call and the one row-drop the four kill paths share (#6892, R1 of #6877): the sidebar's Kill session (agent_actions.js), the agent view's (controls.js), a folder's Kill all and a team's Kill Team
 * (team_actions.js) each wrote their own fetch and follow-up and had drifted. Each caller keeps its confirmation words and its own change of view. */
import { state } from './state.js';
import { sessionServer, teamFetch } from './server_base.js';
import { stopCaptureRefresh } from './capture.js';
import { redrawLiveList } from './list_hooks.js';
import { importOnce } from './import_once.js';

/** Kill one agent: POST its kill with its type and session id to its server. Resolves to the parsed answer ({ ok, error?, changes_artifact_error?, worktree? }), or null when the body is not JSON. Network errors throw. */
export const killLiveSession = (row, server) => importOnce('./kill_pending.js').then(m => m.killWithMark(row, server)); // the call and the Stopping... mark on the row are kill_pending.js's (#15370)

/** Stop a whole team through the team route, so the team is marked stopped as an API kill does (its worktree is then not "in use"): resolves to { ok, answer } (answer: { ok, sessions_killed, worktree? } or null). */
export async function killLiveTeam(boardKey, rows = []) {
    const release = rows.length ? await importOnce('./kill_pending.js').then(m => m.markStopping(rows)) : () => {}; // every row of the team says Stopping... until the one answer (#15431)
    let out;
    try {
        const resp = await teamFetch(boardKey, n => `/api/sessions/live/team/${encodeURIComponent(n)}/kill`, { method: 'POST' });
        out = { ok: resp.ok, answer: await resp.json().catch(() => null) };
    } catch (e) { release(rows.map(r => r.session_id)); throw e; }
    release(out.ok ? [] : rows.map(r => r.session_id));
    return out;
}

/** The killed agents' rows go at once (their chats stay in History), by session id AND server (the same id on another server is another agent). When the open agent is one of them its capture refresh stops. The list is redrawn. */
export function dropKilledRows(rows) {
    const gone = new Set(rows.map(s => s.session_id + '@' + sessionServer(s)));
    if (state.currentSession && gone.has(state.currentSession.session_id + '@' + sessionServer(state.currentSession))) stopCaptureRefresh();
    state.liveSessions = (state.liveSessions || []).filter(s => !gone.has(s.session_id + '@' + sessionServer(s)));
    redrawLiveList();
    dispatchEvent(new Event('kill')); // an open Agents tab reads its rows again: a killed agent stops reading Busy (walk 17 M5)
}
