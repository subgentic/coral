/* An agent whose start was refused because its CLI is missing or can't be run (#353): the server marks it asleep with the reason cli_missing, and the page says "Failed to start" with
   fixed words built here from the agent's type alone. Nothing the server or the agent sent is put in the sentence, and it is only ever written as text (textContent), never as markup. */

const CLI_NAMES = { claude: 'Claude', codex: 'Codex', pi: 'Pi', agy: 'Antigravity', gemini: 'Antigravity' };
const CLI_PROGRAMS = { claude: 'claude', codex: 'codex', agy: 'agy', gemini: 'agy', pi: 'pi' };

/** True for a sleeping, not archived agent whose start was refused for its CLI. */
export function isStartFailed(row) {
    return !!row && !!row.sleeping && !row.archived && row.sleep_reason === 'cli_missing';
}

/** The one line that says how to fix it: Settings > CLI paths > Codex to its codex.exe. */
export function startFailedFix(agentType) {
    const name = CLI_NAMES[agentType];
    if (!name) return 'Set the agent’s program in Settings > CLI paths.';
    const prog = CLI_PROGRAMS[agentType];
    const exe = /Windows/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '') ? `${prog}.exe` : prog;
    return `Set Settings > CLI paths > ${name} to its ${exe}.`;
}

/** The status line: "<who> failed to start: the Codex CLI was not found. Set Settings > CLI paths > Codex to its codex.exe." (who is the agent's own name, written as text). */
export function startFailedText(who, agentType) {
    const name = CLI_NAMES[agentType] || 'agent';
    return `${who} failed to start: the ${name} CLI was not found. ${startFailedFix(agentType)}`;
}
