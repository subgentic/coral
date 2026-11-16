/* Continue is a message to this terminal, not a restart or a replacement for the composer's draft. */
import { state } from './state.js';
import { serverFetch, sessionServer } from './server_base.js';
import { hubBlocked } from './hub_access.js';
import { showToast } from './utils.js';
import { responseErrorText } from './server_status.js';
import { markStopped, wasStopped } from './stopped_agents.js';
import { redrawLiveList } from './list_hooks.js';
import { addPendingMessage, confirmPendingMessage, removePendingMessage } from './live_chat.js';
import { noteHeld } from './held_sends.js';
const sending = new Set();
export async function continueAgent(el) {
    const row = (state.liveSessions || []).find(s => s.session_id === el.dataset.sessionId && sessionServer(s) === el.dataset.server);
    if (!row || !wasStopped(row) || row.sleeping || await hubBlocked(row)) return;
    const key = JSON.stringify([sessionServer(row), row.session_id]);
    if (sending.has(key)) return;
    sending.add(key);
    const at = Date.now();
    addPendingMessage(row.session_id, 'continue', at, { sending: true });
    try {
        const resp = await serverFetch(sessionServer(row), `/api/sessions/live/${encodeURIComponent(row.name)}/send`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'continue', agent_type: row.agent_type, session_id: row.session_id }),
        });
        if (!resp.ok) throw new Error(await responseErrorText(resp, sessionServer(row), 'Continue was not confirmed.'));
        const result = await resp.json();
        if (result.error) throw new Error(result.error);
        if (result.held) {
            removePendingMessage(row.session_id, at, { announce: false });
            if (result.held_id != null) noteHeld(row.session_id, undefined, 'continue', result.held_id);
            showToast(result.note || "Held until the agent's question is answered.");
        } else {
            confirmPendingMessage(row.session_id, at);
            markStopped(row, false);
            redrawLiveList();
            showToast('Continue sent.');
        }
    } catch (error) {
        removePendingMessage(row.session_id, at, { announce: false });
        showToast(error.message || 'Continue was not confirmed. Check the connection.', true);
    } finally { sending.delete(key); }
}
