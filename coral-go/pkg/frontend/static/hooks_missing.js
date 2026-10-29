/* Running agents whose hook programs are gone (#6089): the app they were started from was replaced or moved while they ran, so their hooks cannot run and Coral cannot confirm what they take.
 * The server lists them (hooks-status "missing"); each is flagged once, on its row. Restarting the agent starts it with the tools that are there now. */
import { state } from './state.js';
import { escapeAttr } from './utils.js';
import { redrawLiveList } from './list_hooks.js';

/** The chip on an agent's row: "Hooks can't run", with the fix in its tooltip. */
export function hooksMissingChip(s) {
    if (!s || !state.hooksMissing || !state.hooksMissing.has(s.session_id)) return '';
    const why = "Coral can't reach this agent's hooks, so it can't confirm messages you send it. Reopen Coral or restart the agent.";
    return `<span class="chip hooks-missing-chip" role="img" aria-label="${escapeAttr("Hooks can't run. " + why)}" title="${escapeAttr(why)}">Hooks can't run</span>`;
}

/** The chip on a Pi agent's row when its extension has not reported (#11107): Coral starts every Pi agent with its own extension, whose first event is the handshake. Quiet, and only a statement: the agent's state is
 *  still read from Pi's session files, so nothing about it is held back. */
export function piHooksChip(s) {
    if (!s || !state.piHooksInactive || !state.piHooksInactive.has(s.session_id)) return '';
    const why = "Coral's hooks have not reported from this Pi agent, so its state comes from Pi's session files and may lag a little. Restart the agent to start them.";
    return `<span class="chip hooks-inactive-chip" role="img" aria-label="${escapeAttr("Hooks not active. " + why)}" title="${escapeAttr(why)}">Hooks not active</span>`;
}

export function setPiHooksInactive(agents) {
    const next = new Set((agents || []).map(a => a.session_id));
    const now = state.piHooksInactive || new Set();
    if (next.size === now.size && [...next].every(id => now.has(id))) return;
    state.piHooksInactive = next;
    redrawLiveList();
}

/** The server's list of agents without hooks: the rows are drawn again only when the set changes. */
export function setHooksMissing(agents) {
    const next = new Set((agents || []).map(a => a.session_id));
    const now = state.hooksMissing || new Set();
    if (next.size === now.size && [...next].every(id => now.has(id))) return;
    state.hooksMissing = next;
    redrawLiveList();
}
