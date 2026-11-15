/* A single agent's question (#18106): the Operator's answer is typed into that agent's conversation. Loaded only when such a row is answered. */
import { serverFetch } from './server_base.js';
import { refreshOperatorAsks } from './operator_asks.js';

/** POST the answer to the agent's question; rejects with the server's own words when it is refused. The list is read again, so the row is gone. */
export async function answerAgentAsk(a, text) {
    const body = String(text || '').trim();
    if (!body) throw new Error('Write a reply first.');
    const resp = await serverFetch(a.server, `/api/agent-asks/${encodeURIComponent(a.id)}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: body }) });
    if (!resp.ok) {
        let why = '';
        try { const b = await resp.json(); why = b.message || b.error || ''; } catch { /* not JSON */ }
        throw new Error(why ? `Not sent: ${why}` : `Not sent (HTTP ${resp.status}).`);
    }
    refreshOperatorAsks(true);
}
