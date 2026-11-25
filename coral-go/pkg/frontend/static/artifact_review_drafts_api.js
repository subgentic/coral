/* Private document review drafts (#21185/#21189). These routes never fall back to
 * published comments: an unavailable draft/send route must keep the draft private. */
import { serverUrl } from './server_base.js';

const base = (hex, server) => serverUrl(`/api/artifacts/${hex}/review-drafts`, server);
const query = board => board ? `?board=${encodeURIComponent(board)}` : '';
async function request(url, method = 'GET', body) {
    const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    let data;
    try { data = await response.json(); } catch { throw new Error('The computer did not confirm this review action. Your drafts may still be saved; check before retrying.'); }
    if (!response.ok) {
        const error = new Error(data.message || data.error || `Review action failed (HTTP ${response.status}).`);
        error.status = response.status; error.code = data.code || data.error; error.revision = data.revision;
        throw error;
    }
    return data;
}
export const readDrafts = (hex, server, board) => request(base(hex, server) + query(board));
export const createDraft = (hex, server, board, draft) => request(base(hex, server), 'POST', { ...draft, board });
export const editDraft = (hex, server, board, id, draft, revision) => request(`${base(hex, server)}/${encodeURIComponent(id)}${query(board)}`, 'PATCH', { ...draft, revision });
export const deleteDraft = (hex, server, board, id, revision) => request(`${base(hex, server)}/${encodeURIComponent(id)}${query(board)}${board ? '&' : '?'}revision=${encodeURIComponent(revision)}`, 'DELETE');
// The caller owns request_id and keeps it across unknown outcomes; never generate
// another UUID inside this adapter or retry a POST on the caller's behalf.
export const sendDrafts = (hex, server, board, batch) => request(`${base(hex, server)}/send`, 'POST', { ...batch, board });

// These server refusals happen before delivery or explicitly roll it back.
// Network errors, internal failures and unconfirmed write outcomes must retain the UUID.
export const reviewRefused = code => ['stale_revision', 'review_too_large', 'not_delivered', 'comments_locked', 'board_paused', 'no_agent', 'no_drafts', 'no_board', 'no_uploader', 'ambiguous_uploader', 'rate_limited', 'thread_gone', 'too_many_comments', 'redaction_unavailable', 'owner_only', 'comments_forbidden', 'already_decided'].includes(code);
