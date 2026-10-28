/* When more than one team exists, a row or a notice that names an agent names its team too (#10134, Beta #10130): two teams each have an Orchestrator, and "Orchestrator" twice tells nobody which is which.
 * One team (or none): nothing changes. The answer is read from the dashboard's own live list, so a chat whose agent is no longer on it has no team to name. */
import { state } from './state.js';
import { keyLabel, identityKey, sessionServer } from './server_base.js';
import { _getBoardColor } from './board_accents.js';

const teamKey = s => (s && s.board_project ? identityKey(sessionServer(s), s.board_project) : '');

/** Whether two or more teams are on the live list. */
export function manyTeams() {
    const seen = new Set();
    for (const s of state.liveSessions || []) { const k = teamKey(s); if (k) { seen.add(k); if (seen.size > 1) return true; } }
    return false;
}

/** The live row of a chat's agent (a history row carries the agent's session id), or null once it is gone. */
const liveOf = id => (id ? (state.liveSessions || []).find(x => x.session_id === id) || null : null);

/** { name, color } of the team of a live row, or null when there is none to say (one team, no team, an agent no longer listed). color is the person's own pick, or ''. */
export function teamOf(row) {
    if (!row || !row.board_project || !manyTeams()) return null;
    return { name: keyLabel(row.board_project), color: _getBoardColor(row.board_project) || '' };
}
/** The same for a chat (history) row, through its session id. */
export const teamOfChat = chat => teamOf(liveOf(chat && chat.session_id));

/** An agent's name for a notice or a row: "Orchestrator (team-a)" when two or more teams exist, else the name alone. */
export function withTeam(name, row) {
    const t = teamOf(row);
    return t ? `${name} (${t.name})` : String(name);
}
