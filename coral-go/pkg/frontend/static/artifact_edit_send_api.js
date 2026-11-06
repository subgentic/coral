/* Metadata only until the person explicitly sends. The server owns the diff. */
import { boardFetch } from './server_base.js';
const HEX = /^[a-f0-9]{64}$/;
const path = context => { if (!context || !HEX.test(String(context.hex))) throw new Error('This saved edit cannot be sent.'); return `/artifacts/${context.hex}/edit/send`; };
export async function editSendCapability(context, { signal } = {}) {
    if (!context) return null;
    const r = await boardFetch(context.key, path(context), { signal, headers: { Accept: 'application/json' } });
    if ([403, 404, 405].includes(r.status)) return null;
    const data = await r.json().catch(() => ({}));
    if (r.status === 409 && data.code === 'not_an_edit') return null;
    if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Send availability could not be read.');
    if (data.can_send_edit !== true || !HEX.test(String(data.base_digest)) || !Number.isSafeInteger(data.base_version) || !Number.isSafeInteger(data.version) || data.base_version < 1 || data.version <= data.base_version) return null;
    return { ...data, sent_to: Array.isArray(data.sent_to) ? data.sent_to.filter(a => typeof a === 'string') : [] };
}
export async function sendSavedEdit(context, agents) {
    if (!Array.isArray(agents) || agents.length < 1 || agents.length > 10 || agents.some(a => typeof a !== 'string' || !a.trim())) throw new Error('Choose up to 10 agents from this team.');
    const r = await boardFetch(context.key, path(context), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents }) });
    const data = await r.json().catch(() => ({}));
    const results = Array.isArray(data.results) ? data.results.map(a => ({ agent: String(a.agent || ''), state: String(a.state || ''), reason: String(a.reason || '') })) : [];
    return { ok: r.ok, status: r.status, commentId: Number.isSafeInteger(data.thread_id) && data.thread_id > 0 ? data.thread_id : null, results, omitted: data.limited === true, error: typeof data.error === 'string' ? data.error : (r.ok ? '' : `The edit could not be sent (HTTP ${r.status}).`) };
}
