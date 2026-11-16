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

/** One picture for the reply, stored as the asking agent's own file; resolves like uploadCommentImage ({hex, name, contentType, size}). */
export async function uploadAgentAskImage(a, blob) {
    const resp = await serverFetch(a.server, `/api/agent-asks/${encodeURIComponent(a.id)}/images`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    let d = {};
    try { d = await resp.json(); } catch { /* an answer that is not JSON has no reason */ }
    if (!resp.ok || !/^[0-9a-f]{64}$/.test(String(d.hex || ''))) { const e = new Error((d && (d.message || d.error)) || `The picture was not stored (HTTP ${resp.status}).`); e.status = resp.status; throw e; }
    return { hex: d.hex, name: String(d.name || ''), contentType: String(d.content_type || blob.type), size: Number(d.size) || blob.size };
}
