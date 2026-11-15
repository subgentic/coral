/* A single agent's question (#18106): the Operator's answer is typed into that agent's conversation. Loaded only when such a row is answered. */
import { serverFetch } from './server_base.js';

/** POST the answer; the response is handed back as replyToAsk reads it, with the server's own words in `error` when it is refused. */
export async function answerAgentAsk(a, body) {
    const resp = await serverFetch(a.server, `/api/agent-asks/${encodeURIComponent(a.id)}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: body }) });
    if (resp.ok) return resp;
    let why = '';
    try { const b = await resp.json(); why = b.message || b.error || ''; } catch { /* not JSON */ }
    return { ok: false, status: resp.status, json: async () => ({ error: why }) };
}
