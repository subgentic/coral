/* A send whose answer never came back usable (#18592): through the Hub, POST /send can answer after the tunnel's or the Hub's header limit (an agent mid-compaction), a gateway
   error or a dropped connection, while Coral already typed the text. The agent's live row lists what Coral typed in the last 90 seconds (pending_sends, #10467): when the text is there,
   it arrived, and the composer must not say it was not sent or put it back in the box (a second send would type it twice). Loaded only when a send fails that way. */
import { state } from './state.js';
import { loadLiveSessions } from './api.js';
import { sessionServer } from './server_base.js';

const PENDING_SENDS_RUNES = 1000; // the row keeps a message's first 1000 characters (pendingSendsRunes in routes/pending_sends.go)
const flat = text => String(text || '').replace(/\s+/g, ' ').trim();

/** True when the agent's row, read again now, lists text as typed. */
export async function typedAnyway(sessionId, server, text) {
    try { await loadLiveSessions(); } catch { return false; }
    const row = (state.liveSessions || []).find(s => s && s.session_id === sessionId && sessionServer(s) === server);
    const want = flat(text), cut = Array.from(String(text || '')).length >= PENDING_SENDS_RUNES;
    return !!row && Array.isArray(row.pending_sends) && row.pending_sends.some(p => p && p.text && (flat(p.text) === want || (cut && want.startsWith(flat(p.text)))));
}
