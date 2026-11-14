/* Dismiss on a question to the Operator (#11552, the approved action set): the question leaves Needs you with nothing said to the agent that asked, and a toast offers Undo. Closing a question is the board's own route
 * (POST .../asks/<id>/close) with a fixed note, which is shown with the ask; Undo is the same route with undo:true (the Operator's alone: the asker and every other token are refused). A `wait --operator` has no ask row
 * and no close route, so only an ask is ignorable. Lazy: the Inbox loads it on the first Dismiss. */
import { showToast, announceNotice } from './notifications.js';
import { refreshOperatorAsks } from './operator_asks.js';
import { markHidden } from './visible_marks.js';
import { serverFetch } from './server_base.js';

const NOTE = 'Dismissed by the operator';

async function close(a, body) {
    const r = await serverFetch(a.server, `/api/board/${encodeURIComponent(a.board)}/asks/${encodeURIComponent(a.id)}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return;
    let why = '', code = ''; try { const b = await r.json(); why = b.message || b.error || ''; code = b.code || b.error || ''; } catch { /* not JSON */ }
    throw Object.assign(new Error(why || `Could not save (HTTP ${r.status}).`), { code });
}

/** Close the question quietly. `who` is the asker as it is drawn (hidden characters written out). Resolves when the route answered; rejects with its words. */
export async function ignoreAsk(a, who) {
    const h = { table: null }; document.dispatchEvent(new CustomEvent('coral:action-start', { detail: h })); // the table on screen when the Dismiss began: only it gets the one unheld redraw (#14373)
    await close(a, { note: NOTE });
    Promise.resolve(refreshOperatorAsks(true)).catch(() => {}).then(() => { document.dispatchEvent(new CustomEvent('coral:action-result', { detail: h })); }); // the list has been read again: its one redraw for this action is not held under a resting pointer (#14373)
    const flat = markHidden(String(a.text || ''), { strict: true }).replace(/\s+/g, ' ').trim(), what = flat ? `"${flat.length > 48 ? flat.slice(0, 47).trimEnd() + '\u2026' : flat}" from ${who}` : `the question of ${who}`; // which one, since nine ignores said the same line nine times (#12112)
    showToast(`Dismissed ${what}`, false, undefined, { action: { label: 'Undo', onClick: () => close(a, { undo: true }).then(() => { refreshOperatorAsks(true); announceNotice(`The question of ${who} is back in Needs you.`); }).catch(e => showToast(e.message, true)) } });
    announceNotice(`Dismissed ${what}. Undo is in the notice.`);
}

/** The bulk Dismiss of a phone's selection (#11671): the same close route and Undo, with one toast for the whole selection (said by the caller). */
export const closeAsk = a => close(a, { note: NOTE });
export const reopenAsk = (a, { unanswer = false } = {}) => close(a, { undo: true, ...(unanswer ? { unanswer: true } : {}) }).then(() => refreshOperatorAsks(true));
export { refreshOperatorAsks };
