/* How a dialog or a toast names an agent, and what it says stays (#10139, Beta tester #10135): the agent's role and team ("QA Engineer in alpha"), not the name of the folder it works in; and for a team's
 * Delete and a folder's Unpin, what is lost and what is left alone. Pure text: every function returns a string for textContent. */
import { keyLabel, sessionTeamKey } from './server_base.js';

const oneLine = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** { role, team, label } for an agent row (the live list's session): its role (board_job_title) else `identity` (the name its row shows) else its name; its team when it has one. */
export function agentWords(s, identity = '') {
    const role = oneLine(s && s.board_job_title) || oneLine(identity) || oneLine(s && (s.display_name || s.name)) || 'this agent';
    const key = s ? sessionTeamKey(s) : '';
    const team = key ? oneLine(keyLabel(key)) : '';
    return { role, team, label: team ? `${role} in ${team}` : role };
}

/** What a kill leaves alone (its worktree, when it has one, and the terminal log are said beside this). */
export const WHAT_STAYS_KILL = "Its chat stays in History.";
/** The same for a team or a folder of agents killed together, and what a reset leaves alone (#10371: the confirms said terminate and context, and not what stays). */
export const WHAT_STAYS_KILL_MANY = "Their chats stay in History.";
export const WHAT_STAYS_RESET = "The old chats stay in History and your files are not touched.";
/** A Hermes agent keeps its conversation in a Hermes home of its own, deleted with the agent, and Hermes keeps no other copy: a kill or a reset must not promise History for it (#11956). */
const isHermes = s => !!s && s.agent_type === 'hermes';
const NO_OTHER_COPY = 'Hermes keeps no other copy';

/** What a kill leaves alone, for the agents it ends (sessions: the rows). */
export function whatStaysKill(sessions) {
    const rows = sessions || [];
    const hermes = rows.filter(isHermes).length;
    if (!hermes) return rows.length === 1 ? WHAT_STAYS_KILL : WHAT_STAYS_KILL_MANY;
    if (rows.length === 1) return `Its conversation is deleted with it: ${NO_OTHER_COPY}.`;
    if (hermes === rows.length) return `Their conversations are deleted with them: ${NO_OTHER_COPY}.`;
    return `${WHAT_STAYS_KILL_MANY} Except the ${hermes} Hermes agent${hermes === 1 ? '' : 's'}: ${hermes === 1 ? 'its conversation is' : 'their conversations are'} deleted with ${hermes === 1 ? 'it' : 'them'} (${NO_OTHER_COPY}).`;
}

/** What a reset leaves alone, for the agents it restarts. */
export function whatStaysReset(sessions) {
    if (!(sessions || []).some(isHermes)) return WHAT_STAYS_RESET;
    return `${WHAT_STAYS_RESET} A Hermes agent's old conversation is the exception: it is deleted (${NO_OTHER_COPY}).`;
}

/** What a sleep stops, and what it leaves alone (#10785: the dialog named the folder and said nothing of either). */
export const WHAT_STAYS_SLEEP = 'It stops running; its chat and files stay, and Wake brings it back.';
/** What an archive leaves alone, and the way back. */
export const WHAT_STAYS_ARCHIVE = 'Its chat history and files stay; Unarchive brings it back.';

/** The Delete team dialog's words (and, with the names of agents still running on it, the dialog that says why it cannot be deleted yet). */
export function deleteTeamWords(team, running = []) {
    const name = oneLine(team);
    if (running.length) {
        const shown = running.length > 5 ? `${running.slice(0, 5).join(', ')} and ${running.length - 5} more` : running.join(', ');
        return `${name} still has ${running.length} agent${running.length === 1 ? '' : 's'} running: ${shown}. Kill them or move them to another team first, then delete the team. Nothing was deleted.`;
    }
    return `Delete team "${name}"? This deletes its messages, tasks, goals, members, reminders, waits, presets, settings, artifact tags and health data for good. The agents' chats stay in History, and the files in the team's folder are not touched. This cannot be undone.`;
}

/** The toast after a folder is taken off the list: what it did and did not do. */
export function unpinWords(path) {
    const base = oneLine(String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop());
    return `Removed ${base || 'the folder'} from your list. Its files were not changed.`;
}
