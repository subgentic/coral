/* The board's composer: Reply and posting (moved out of message_board.js, #8399; no behaviour change). */
import { importOnce } from './import_once.js';
import { blockedReason } from './hub_access.js';
import { splitKey, boardFetch } from './server_base.js';
import { showToast, OPERATOR_ID } from './utils.js';
import { isOutcomeUnknown, OUTCOME_UNKNOWN_LINE } from './outcome_unknown.js';
import { bs } from './board_state.js';
const { _pollNewMessages } = await importOnce('./board_poll.js'); // a part of the board page's group: loaded with it

/** Reply: "@Sender " goes at the start of the composer's text and the focus to it; the post carries reply_to while the text still starts with the name. */
export function replyToMessage(id, name) {
    const input = document.getElementById('mb-post-input');
    if (!input) return;
    const prefix = `@${name} `;
    if (!input.value.toLowerCase().startsWith(prefix.toLowerCase())) input.value = prefix + input.value;
    bs._replyTo = { id: Number(id), name };
    input.dispatchEvent(new Event('input', { bubbles: true })); // the growing box follows the text
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

export async function postBoardMessage() {
    if (!bs.currentProject) return;
    const blocked = blockedReason(splitKey(bs.currentProject).server, 'interact');
    if (blocked) { showToast(blocked, true); return; }
    const input = document.getElementById('mb-post-input');
    const content = input.value.trim();
    if (!content) return;

    try {
        const resp = await boardFetch(bs.currentProject, `/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content, ...(bs._replyTo && content.toLowerCase().startsWith(`@${bs._replyTo.name.toLowerCase()}`) ? { reply_to: bs._replyTo.id } : {}) }),
        });
        if (!resp.ok) {
            // The draft stays; say why, in the server's words when it gives them (a per-sender rate
            // limit's "too many messages…; retry in 20s", #3435).
            const text = await resp.text().catch(() => '');
            let reason = '';
            let unknown = false;
            try { const b = JSON.parse(text); if (b && typeof b.error === 'string') reason = b.error; unknown = isOutcomeUnknown(resp.status, b, resp.url); } catch { /* not JSON */ }
            console.error('Post failed:', resp.status, text);
            showToast(unknown ? OUTCOME_UNKNOWN_LINE : reason ? `Not posted: ${reason}` : `Not posted (HTTP ${resp.status}).`, true);
            return;
        }
        input.value = '';
        bs._replyTo = null;
        // Fetch new messages since our last known total
        await _pollNewMessages();
        const list = document.getElementById('mb-messages'); if (list) list.scrollTop = list.scrollHeight; // the person's own message is the newest, and in view (#10088)
    } catch (e) {
        console.error('Failed to post message:', e);
    }
}
