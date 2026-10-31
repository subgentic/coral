/* Dismiss a wait that is no longer true (#11352): a "Permission needed" card and its Needs you row that stay after the agent went on (the operator's report). Only the Operator: through Coral Hub the account this
 * computer is linked to alone (the machine answers anyone else 403 owner_only, and the toast says so). It clears Coral's own record of the wait (POST .../dismiss-wait); it sends nothing to the agent and presses nothing in its terminal. Offered for a request of the agent's own
 * kinds (permission, question, plan), never for a sign-in or a launch prompt, and not where the person may not act. */
import { serverFetch, sessionServer } from './server_base.js';
import { loadLiveSessions } from './api.js';
import { showToast } from './utils.js';

const KINDS = new Set(['permission', 'question', 'plan']);

/** Whether the Dismiss is drawn for an agent's open request of this kind. */
export function canDismissWait(session, kind) {
    return !!(session && session.session_id && KINDS.has(kind));
}

/** The button the card and the row draw: text, a name that says what it does, and what it never does. */
export function dismissButton(className, session) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = 'Dismiss';
    b.title = 'Clear this if the agent is not waiting. Nothing is sent to the agent.';
    b.dataset.dismissSession = session.session_id;
    return b;
}

/** Clears the wait of a session and says so; the live list is read again so the card and the row go. */
export async function dismissWait(session, button) {
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
        showToast(said.dismissed ? 'Dismissed. Nothing was sent to the agent.' : 'It was not waiting any more.', false, 4000);
        await loadLiveSessions();
    } catch {
        if (button) button.disabled = false;
        showToast('Could not dismiss it. Try again.', true);
    }
}
