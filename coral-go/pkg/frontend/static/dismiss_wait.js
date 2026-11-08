/* Dismiss a wait that is no longer true (#11352): a "Permission needed" card and its Needs you row that stay after the agent went on (the operator's report). Only the Operator: through Coral Hub the account this
 * computer is linked to alone (the machine answers anyone else 403 owner_only, and the toast says so). It clears Coral's own record of the wait (POST .../dismiss-wait); it sends nothing to the agent and presses nothing in its terminal. Offered for a request of the agent's own
 * kinds (permission, question, plan), never for a sign-in or a launch prompt, and not where the person may not act. */
import { serverFetch, sessionServer, isCloud } from './server_base.js';
import { loadLiveSessions } from './api.js';
import { showToast } from './utils.js';
import { askedBefore, dismissAsked } from './asked_before_restart.js';
import { openAgent } from './agent_live.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';
const { remoteRemoveWaitAllowed, removeWaitRequest } = await importOnce('./remove_wait_policy.js');

/** Whether the Dismiss is drawn for an agent's open request: every waiting agent has one (#11946). The machine clears a permission, question or plan in its record of the wait; any other request (an input prompt, a
 *  dialog, an elicitation, a sign-in) it keeps as hidden, per agent and request, until the agent asks something new; a request made before the agent slept is hidden in this browser. Nothing is sent to the agent. */
export function canDismissWait(session, kind) {
    return !!(session && session.session_id && session.agent_type && !session.review && !session.autorun);
}
const isAsked = (session) => !!askedBefore(session); // a request made before the agent slept lives in its record, not in a live wait: the machine has nothing to clear or hide

/** The button the card and the row draw: text, a name that says what it does, and what it never does. */
export function dismissButton(className, session) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = 'Dismiss';
    b.title = 'Dismiss this notice. An active terminal wait stays listed until the agent continues. Nothing is sent to the agent.';
    b.dataset.dismissSession = session.session_id;
    return b;
}

/** What a Dismiss says (#12465): it clears Coral's record and sends nothing, so an agent that is still waiting (Hermes on a prompt in its terminal) keeps waiting there with no way to answer from Coral once the card is gone: the
 *  notice says so and offers the agent. */
function saidDismiss(text, session) {
    showToast(`${text} If it is still waiting, open its terminal to continue.`, false, 30000, { action: { label: 'Open agent', onClick: () => openAgent(session) } });
}

/** Clears the wait of a session and says so; the live list is read again so the card and the row go. */
export async function dismissWait(session, button) {
    if (isAsked(session)) { // asked before the agent went to sleep: hidden in this browser, for that request only
        dismissAsked(session);
        saidDismiss('Hidden until the agent asks something new. Nothing was sent to the agent.', session);
        return;
    }
    if (button) button.disabled = true;
    try {
        const resp = await serverFetch(sessionServer(session), `/api/sessions/live/${encodeURIComponent(session.name)}/dismiss-wait`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: session.session_id, agent_type: session.agent_type || '' }),
        });
        if (resp.status === 403 && await resp.json().then(b => b && (b.code === 'owner_only' || b.error === 'owner_only'), () => false)) {
            if (button) button.disabled = false;
            showToast('Only the account this computer is linked to can dismiss it.', true);
            return;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const said = await resp.json().catch(() => ({}));
        if (said.hidden || said.dismissed) saidDismiss(said.hidden ? 'Dismissed. An active wait stays in Needs you. Nothing was sent to the agent.' : 'Dismissed. Nothing was sent to the agent.', session); else showToast('It was not waiting any more.', false, 4000); // hidden: a request the machine cannot clear, kept as hidden on the machine (#11946)
        await loadLiveSessions();
    } catch {
        if (button) button.disabled = false;
        showToast('Could not dismiss it. Try again.', true);
    }
}

/** Explicit removal hides only this dismissed request, never answers its terminal. */
export function canRemoveWait(session) {
    const server = sessionServer(session);
    const targetAllowed = (!isCloud() && server === 'local') || remoteRemoveWaitAllowed(server, state.servers, { cloud: isCloud() });
    return targetAllowed && canDismissWait(session) &&
        !!session.waiting_for_input && !!session.wait_ignored && !session.wait_removed &&
        !session.sleeping && !session.archived && Number.isFinite(Date.parse(session.waiting_since));
}
export const REMOVE_WAIT_LINE = 'Hides this request from Needs you. Nothing is sent to the agent.';
export async function removeWait(session, button) {
    const current = (state.liveSessions || []).find(row => row.session_id === session.session_id && sessionServer(row) === sessionServer(session));
    if (!canRemoveWait(current) || current.waiting_since !== session.waiting_since || current.waiting_kind !== session.waiting_kind) {
        showToast('This request has changed. Check the current request.', true); return;
    }
    if (button) button.disabled = true;
    try {
        const request = removeWaitRequest(session, sessionServer(session));
        const response = await serverFetch(request.server, request.path, request.options);
        const body = await response.json().catch(() => ({}));
        if (response.status === 403 && (body.code === 'owner_only' || body.error === 'owner_only')) { showToast('Only the account this computer is linked to can remove it.', true); return; }
        if (!response.ok) { showToast(typeof body.error === 'string' ? body.error : `Could not remove it (HTTP ${response.status}).`, true); return; }
        if (body.removed === true) showToast('Removed from Needs you. Nothing was sent to the agent.');
        else if (body.dismissed === false) showToast('It was not waiting any more.');
        await loadLiveSessions();
    } catch { showToast('Could not remove it. Try again.', true); }
    finally { if (button) button.disabled = false; }
}
