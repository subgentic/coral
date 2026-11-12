/* A Codex agent's live mode, in words (#14051). A person can widen what a Codex agent may do inside Codex itself (Full access); Coral is never told, and every relaunch (Wake, Restart, an auto-wake) starts
 * the CLI again with the settings it was launched with. The server puts two keys on a Codex row, from the agent's own rollout (so display only, never a reason to change anything): codex_live_mode
 * ({approval, sandbox, label}) and, only when a relaunch would give less, codex_relaunch_narrows ({live, launch}). These are the words for the chip beside the agent, the question before a Wake, and the
 * note in the Restart form. Plain text everywhere: callers set textContent, never markup. */

const words = v => (typeof v === 'string' && v.trim() ? v.trim() : '');

/** {live, launch} when the row says a relaunch would start the agent narrower than it runs now, else null. */
export function relaunchNarrowing(row) {
    const n = row && row.codex_relaunch_narrows;
    const live = words(n && n.live), launch = words(n && n.launch);
    return live && launch ? { live, launch } : null;
}

const NOT_KEPT = 'A mode set inside Codex is not kept.';

/** The question before a Wake that would start the agent narrower. */
export function wakeQuestion(who, narrowing) {
    return `Wake ${who}? It ran with ${narrowing.live}. Waking starts Codex again with ${narrowing.launch}, the settings it was launched with: a mode set inside Codex is not kept.`;
}

/** The note in the Restart form, under the permission mode. */
export function restartHint(narrowing) {
    return `Running with ${narrowing.live} now; restarting starts Codex with ${narrowing.launch}, unless you change the permission mode or flags below. ${NOT_KEPT}`;
}

/** The chip beside a Codex agent: {text, title, warn}, or null when the row has no live mode to show (not Codex, or no turn_context read yet). */
export function modeChip(row) {
    if (row && ['codex', 'agy'].includes(row.agent_type) && row.keep_full_access === true) { // Full access is kept (#15735, Security's INFO on #15734): every start gives it, whatever the stored mode and capabilities say, so that is what the chip says, before any turn too
        const stored = words(row.permission_mode);
        return { key: row.agent_type === 'agy' ? 'Started with: ' : 'Mode: ', text: 'Full access', warn: false, title: `Full access is kept for this agent: it starts with Full access on launch, Restart, Wake and Resume, whatever its stored mode${stored ? ` (${stored})` : ''} and capabilities say. Turn it off with the Off button.` };
    }
    if (row && row.agent_type === 'agy') { // what Coral started it with (#14085): agy writes no mode Coral can read back, so this says what the launch gave it, and says so
        const pe = row.permission_effective, text = words(pe && pe.effective);
        if (!text) return null;
        const narrowed = !!(pe && pe.narrowed === true && row.keep_full_access !== true);
        return { key: 'Started with: ', text, warn: narrowed, title: `The mode Coral started this agent in${narrowed ? `, not the ${words(pe.chosen)} that was chosen: ${words(pe.why)}` : ''}. Shown only: agy does not tell Coral if the mode is changed inside it.` };
    }
    if (!row || row.agent_type !== 'codex') return null;
    const live = row.codex_live_mode, text = words(live && live.label);
    if (!text) return null;
    const narrowing = relaunchNarrowing(row);
    const read = [live.approval ? `approval ${live.approval}` : '', live.sandbox ? `sandbox ${live.sandbox}` : ''].filter(Boolean).join(', ');
    let title = `The mode this agent's newest turn ran in${read ? ` (${read})` : ''}, read from its Codex session file. Shown only: Coral does not use it to change anything.`;
    if (narrowing) title += ` Waking or restarting it would start it with ${narrowing.launch}.`;
    return { key: 'Mode: ', text, title, warn: !!narrowing };
}

/** What the capabilities do to the chosen mode (#14085): {chosen, effective, why} when the launch really gives less than was chosen and the Operator has not chosen Full access, else null. From the row's permission_effective (the server's, the Operator's alone). */
export function permissionNarrowing(row) {
    const pe = row && row.permission_effective;
    if (!pe || pe.narrowed !== true || row.keep_full_access === true) return null;
    const chosen = words(pe.chosen), effective = words(pe.effective);
    return chosen && effective ? { chosen, effective, why: words(pe.why) } : null;
}

const KEEP_TITLE = 'Every time this agent starts again (Wake, Restart, a team reset, an update restart) Coral starts it with Full access, whatever its permissions say. Editing its capabilities, or picking a mode when you restart it, turns this off.';
const OFF = { label: 'Off', mode: 'off', aria: 'Turn off keeping Full access on restart' };
const USE = { label: 'Use Full access', mode: 'use', aria: 'Use Full access for this agent: restart it now with Full access' };

/** The chip for the Operator's "keep Full access" (#14061, #14085): {text, title, button, warn}, or null. On: it is kept, with Off. Not on while the capabilities narrow the chosen mode: it says what runs, with Use Full access. */
export function keepChip(row) {
    if (!row || !['codex', 'claude', 'agy'].includes(row.agent_type)) return null;
    if (row.keep_full_access === true) return { text: 'Full access kept on restart', title: KEEP_TITLE, button: OFF, warn: false };
    const n = permissionNarrowing(row);
    if (n) return { text: `Runs with ${n.effective}, not ${n.chosen}`, title: `This agent's ${n.why}. Use Full access restarts it with Full access, and keeps it on every restart.`, button: USE, warn: true };
    return null;
}

/** The overflow menu's item for the same setting: {label, mode} where mode is what pressing it does ('on', 'off', or 'use': set it and restart now). */
export function keepMenuItem(row) {
    if (row && row.keep_full_access === true) return { label: 'Stop keeping Full access on restart', mode: 'off' };
    if (permissionNarrowing(row)) return { label: 'Use Full access for this agent', mode: 'use' };
    return { label: 'Keep Full access on restart', mode: 'on' };
}

/** The question before Use Full access (it restarts the agent): what runs now, what was chosen, and what the button does. */
export function useFullAccessQuestion(who, n, agentType) {
    return `Use Full access for ${who}? It was started with ${n.chosen} chosen, but ${n.why}, so it runs with ${n.effective}. Coral restarts it now with Full access and starts it that way every time it restarts, whatever its role's capabilities say. ${LIFTS[agentType] || LIFTS.agy}`;
}

// What the choice also lifts, in each agent type's words (Security's SHOULD on #14085): not only the mode, the role's own limits too.
const LIFTS = {
    claude: "It also lifts the commands this role is blocked from (Claude's deny rules).",
    codex: "It also lifts the limits this role's capabilities set on what it may touch (its sandbox and approval rules).",
    agy: "It also lifts the limits this role's capabilities set on what it may do.",
};

/** The sentence a team reset's question gets when members have the choice: they restart with Full access too. '' for none. */
export function keepResetNote(count) {
    return count > 0 ? ` ${count} ${count === 1 ? 'agent keeps' : 'agents keep'} Full access.` : '';
}

/** Does a "keep Full access changed" event belong to the agent on screen? Both the session id AND the computer must match, each as the page normalises it: two computers can hold the same session id, and an answer for one must never change the row of the other (UI Reviewer, #14061). */
export function keepEventMatches(detail, sessionId, server) {
    return !!detail && typeof detail.sessionId === 'string' && detail.sessionId !== '' && detail.sessionId === sessionId && typeof detail.server === 'string' && detail.server === server;
}

/** The Info tab's line for the same setting (#14061, #14085): {on, text, button}, or null unless the row says it. The button is Turn off while it is on, Use Full access while the capabilities narrow the mode. */
export function keepInfo(row) {
    if (!row || !['codex', 'claude', 'agy'].includes(row.agent_type) || typeof row.keep_full_access !== 'boolean') return null;
    if (row.keep_full_access) return { on: true, text: 'Kept: every restart (Wake, Restart, a team reset, an update restart) starts it with Full access.', button: { ...OFF, label: 'Turn off' } };
    const n = permissionNarrowing(row);
    if (n) return { on: false, text: `Runs with ${n.effective}, not the ${n.chosen} that was chosen: its ${n.why}.`, button: USE };
    return { on: false, text: 'Not kept: a restart uses the permissions it was launched with.', button: null };
}
