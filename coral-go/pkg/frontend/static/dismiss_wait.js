/* Dismiss a wait that is no longer true (#11352): a "Permission needed" card and its Needs you row that stay after the agent went on (the operator's report). Only the Operator: through Coral Hub the account this
 * computer is linked to alone (the machine answers anyone else 403 owner_only, and the toast says so). It clears Coral's own record of the wait (POST .../dismiss-wait); it sends nothing to the agent and presses nothing in its terminal. Offered for a request of the agent's own
 * kinds (permission, question, plan), never for a sign-in or a launch prompt, and not where the person may not act. */
import { serverFetch, sessionServer } from './server_base.js';
import { loadLiveSessions } from './api.js';
import { showToast } from './utils.js';
import { askedBefore, dismissAsked } from './asked_before_restart.js';
import { openAgent } from './agent_live.js';

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
    b.title = 'Clear this if the agent is not waiting; if it asks again it comes back. Nothing is sent to the agent.';
    b.dataset.dismissSession = session.session_id;
    return b;
}

/** What a Dismiss says (#12465): it clears Coral's record and sends nothing, so an agent that is still waiting (Hermes on a prompt in its terminal) keeps waiting there with no way to answer from Coral once the card is gone: the
 *  notice says so and offers the agent. */
function saidDismiss(text, session) {
    showToast(`${text} If it is still waiting, it waits in its terminal.`, false, 30000, { action: { label: 'Open agent', onClick: () => openAgent(session) } });
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
        if (said.hidden || said.dismissed) saidDismiss(said.hidden ? 'Hidden until the agent asks something new. Nothing was sent to the agent.' : 'Dismissed. Nothing was sent to the agent.', session); else showToast('It was not waiting any more.', false, 4000); // hidden: a request the machine cannot clear, kept as hidden on the machine (#11946)
        await loadLiveSessions();
    } catch {
        if (button) button.disabled = false;
        showToast('Could not dismiss it. Try again.', true);
    }
}
