/* Ignore on a question to the Operator (#11552, the approved action set): the question leaves Needs you with nothing said to the agent that asked, and a toast offers Undo. Closing a question is the board's own route
 * (POST .../asks/<id>/close) with a fixed note, which is shown with the ask; Undo is the same route with undo:true (the Operator's alone: the asker and every other token are refused). A `wait --operator` has no ask row
 * and no close route, so only an ask is ignorable. Lazy: the Inbox loads it on the first Ignore. */
import { showToast, announceNotice } from './notifications.js';
import { refreshOperatorAsks } from './operator_asks.js';

const NOTE = 'Dismissed by the operator';

async function close(a, body) {
    const r = await fetch(`/api/board/${encodeURIComponent(a.board)}/asks/${encodeURIComponent(a.id)}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return;
    let why = ''; try { const b = await r.json(); why = b.message || b.error || ''; } catch { /* not JSON */ }
    throw new Error(why || `Could not save (HTTP ${r.status}).`);
}

/** Close the question quietly. `who` is the asker as it is drawn (hidden characters written out). Resolves when the route answered; rejects with its words. */
export async function ignoreAsk(a, who) {
    await close(a, { note: NOTE });
    refreshOperatorAsks(true);
    showToast(`Ignored the question of ${who}`, false, undefined, { action: { label: 'Undo', onClick: () => close(a, { undo: true }).then(() => { refreshOperatorAsks(true); announceNotice(`The question of ${who} is back in Needs you.`); }).catch(e => showToast(e.message, true)) } });
    announceNotice(`Ignored the question of ${who}. Undo is in the notice.`);
}

/** The bulk Ignore of a phone's selection (#11671): the same close route and Undo, with one toast for the whole selection (said by the caller). */
export const closeAsk = a => close(a, { note: NOTE });
export const reopenAsk = a => close(a, { undo: true }).then(() => refreshOperatorAsks(true));
export { refreshOperatorAsks };
