/* A send whose answer never came back usable (#18592): through the Hub, POST /send can answer after the tunnel's or the Hub's header limit (an agent mid-compaction), a gateway
   error or a dropped connection, while Coral already typed the text. The agent's live row lists what Coral typed in the last 90 seconds (pending_sends, #10467): when this send's
   text is there, it arrived, and the composer must not say it was not sent or put it back in the box (a second send would type it twice). Loaded only when a send fails that way,
   so the start path pays for none of it (the settling lives here too). */
import { state, sessionKey, saveSessionDraft } from './state.js';
import { loadLiveSessions } from './api.js';
import { sessionServer } from './server_base.js';
import { confirmPendingMessage } from './live_chat.js';
import { clearAttachments } from './image_composer.js';
import { clearComposerError } from './terminal_gone.js';

const PENDING_SENDS_RUNES = 1000; // the row keeps a message's first 1000 characters (pendingSendsRunes in routes/pending_sends.go)
const SKEW_MS = 5000; // the row's times are the Coral's clock, sentAt is this page's: an entry older than this send (less the skew) is an earlier message with the same words
const flat = text => String(text || '').replace(/\s+/g, ' ').trim();

/** True when the agent's row, read again now, lists this send's text as typed since it was sent. */
async function typedAnyway(sessionId, server, text, sentAt) {
    try { await loadLiveSessions(); } catch { return false; }
    const row = (state.liveSessions || []).find(s => s && s.session_id === sessionId && sessionServer(s) === server);
    const want = flat(text), cut = Array.from(String(text || '')).length >= PENDING_SENDS_RUNES;
    return !!row && Array.isArray(row.pending_sends) && row.pending_sends.some(p => p && p.text && Date.parse(p.at) >= sentAt - SKEW_MS && (flat(p.text) === want || (cut && want.startsWith(flat(p.text)))));
}

/** The send arrived after all: settle it as a Sent one (bubble, attachments, error line, draft, toast) and say true; false leaves the caller to take the text back. */
export async function settleTyped(sessionId, sentAt, session, command, toastSent) {
    if (!await typedAnyway(sessionId, sessionServer(session), command, sentAt)) return false;
    confirmPendingMessage(sessionId, sentAt); clearAttachments(session); clearComposerError();
    const k = sessionKey(session); if (k) saveSessionDraft(k, "");
    toastSent(command);
    return true;
}

/** True when a send was refused because the name or type sent is not the session's stored one (the server's code session_target_mismatch). */
async function isTargetMismatch(resp) {
    if (resp.status !== 400) return false;
    try { const b = await resp.clone().json(); return !!b && b.code === 'session_target_mismatch'; } catch { return false; }
}

/** The session's row in a fresh list that differs from the name and type just sent, or null when the list cannot be read, no longer has it, or still says the same.
 *  A read already under way when the refusal came may be older than the restart, so the list is read a second time before giving up. */
async function refetchedTarget(sessionId, server, sentName, sentType) {
    for (let i = 0; i < 2; i++) {
        try { await loadLiveSessions(); } catch { return null; }
        const row = (state.liveSessions || []).find(s => s && s.session_id === sessionId && sessionServer(s) === server);
        if (row && (row.name !== sentName || row.agent_type !== sentType)) return row;
    }
    return null;
}

/** The row to send again to when this refused send (400) was a target mismatch and the fresh list names a different name or type, else null. Kept here, off the start path, because only a refused send needs it. */
export async function changedTarget(resp, sessionId, server, sentName, sentType) {
    return await isTargetMismatch(resp) ? refetchedTarget(sessionId, server, sentName, sentType) : null;
}
