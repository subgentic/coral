/* Send now (#7554): the agent view's held-messages notice (held_inputs.js) can deliver what Coral holds for the open agent at once. Coral holds an agent's automated messages while it judges the agent busy or
 * asking; when that is wrong, the Operator sends them by hand. The server types them into the agent's input box whether or not it is in the middle of a turn (the notice says so), and never into a prompt that is open. */
import { registerActions } from './actions.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { serverFetch, currentServer } from './server_base.js';
import { responseErrorText } from './server_status.js';

/** What to tell the person after a send, from the server's counts. */
export function sendNowToast(r) {
    if (r && r.draft_in_box) return 'There is a draft in the agent\'s input box: nothing was sent. Send or clear it first.';
    if (r && r.prompt_open) return 'A prompt is open in the agent\'s terminal: nothing was sent into it. Answer it first.';
    const n = Number(r && r.sent) || 0;
    if (n > 0) return `Sent ${n} message${n === 1 ? '' : 's'} now.`;
    return 'Nothing was held any more.';
}

let busy = false;

async function sendHeldNow() {
    const s = state.currentSession;
    if (!s || busy) return;
    busy = true;
    try {
        const resp = await serverFetch(currentServer(), `/api/sessions/live/${encodeURIComponent(s.name)}/held/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_type: s.agent_type, session_id: s.session_id, id: '' }),
        });
        if (!resp.ok) { showToast(await responseErrorText(resp, currentServer(), `The messages were not sent (HTTP ${resp.status}).`)); return; }
        showToast(sendNowToast(await resp.json()));
    } catch (e) {
        showToast('The messages were not sent: ' + (e && e.message ? e.message : 'the server did not answer.'));
    } finally { busy = false; }
}

registerActions({ 'held-send-now': () => sendHeldNow() });
