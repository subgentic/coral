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
    if (!row || row.agent_type !== 'codex') return null;
    const live = row.codex_live_mode, text = words(live && live.label);
    if (!text) return null;
    const narrowing = relaunchNarrowing(row);
    const read = [live.approval ? `approval ${live.approval}` : '', live.sandbox ? `sandbox ${live.sandbox}` : ''].filter(Boolean).join(', ');
    let title = `The mode this agent's newest turn ran in${read ? ` (${read})` : ''}, read from its Codex session file. Shown only: Coral does not use it to change anything.`;
    if (narrowing) title += ` Waking or restarting it would start it with ${narrowing.launch}.`;
    return { text, title, warn: !!narrowing };
}

/** The Operator's "keep Full access when this agent restarts" (#14061): {text, title} for the chip with its Off button, or null unless the row says it is on (the server gives the key only to the Operator, for a Codex row). */
export function keepChip(row) {
    if (!row || row.agent_type !== 'codex' || row.keep_full_access !== true) return null;
    return { text: 'Full access kept on restart', title: 'Every time this agent starts again (Wake, Restart, an update restart) Coral starts Codex with Full access, whatever its permissions say. Editing its capabilities, or picking a mode when you restart it, turns this off.' };
}

/** The overflow menu's item for the same setting: {label, mode} where mode is what pressing it sets ('on' or 'off'). */
export function keepMenuItem(row) {
    return row && row.keep_full_access === true ? { label: 'Stop keeping Full access on restart', mode: 'off' } : { label: 'Keep Full access on restart', mode: 'on' };
}

/** The Info tab's line for the same setting (#14061): {on, text}, or null unless the row says it either way (a Codex row of the Operator's). The Off button is shown only while it is on. */
export function keepInfo(row) {
    if (!row || row.agent_type !== 'codex' || typeof row.keep_full_access !== 'boolean') return null;
    return row.keep_full_access
        ? { on: true, text: 'Kept: every restart (Wake, Restart, an update restart) starts Codex with Full access.' }
        : { on: false, text: 'Not kept: a restart uses the permissions it was launched with.' };
}
