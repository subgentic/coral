/* Questions to the Operator in their Needs you (#11417). An agent asks the Operator with `coral-board post --ask "@Operator ..."` or `coral-board wait --operator "..."`; neither was in the Inbox, which is
 * built from the live list, so the person did not see what they were asked. GET /api/operator-asks lists both for every board (the whole question as text); a row of Needs you says who asks and the question
 * on one line, and opens whole in a dialog with a Reply box. The reply is the board post the dashboard already makes (POST /api/board/{board}/messages as the Operator, with the asker's @name, and reply_to
 * for an ask): it answers the ask, ends a wait, and tells the asker by the post itself. The text is the agent's, so it is written out through markHidden (strict) before it is drawn, then cut. */
import { markHidden } from './visible_marks.js';
import { OPERATOR_ID } from './utils.js';

const FRESH_MS = 15000, LINE_MAX = 140;
let asks = [], pending = null, lastRead = 0;
const listeners = new Set();
/** The open questions, oldest first. */
export const operatorAsks = () => asks;
/** Called after a read that changed the list. Returns the way to stop. */
export const onOperatorAsksChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const fire = () => { for (const f of listeners) f(); };

/** A question as one line of a row: hidden characters written out, white space collapsed, cut after marking so a mark is never split. */
export function askLine(a) {
    const one = markHidden(a && a.text, { strict: true }).replace(/\s+/g, ' ').trim();
    return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1).trimEnd()}…` : one;
}
/** The whole question, hidden characters written out, line breaks kept. */
export const askWhole = a => markHidden(a && a.text, { strict: true });
/** A stable id of one question among the rows. */
export const askKey = a => `operator-ask:${a.board}:${a.kind}:${a.id}`;

/** Read the list (at most once in 15 s unless forced; one read at a time). Safe to call after every live update. */
export function refreshOperatorAsks(force = false) {
    if (pending) return pending;
    if (!force && Date.now() - lastRead < FRESH_MS) return null;
    lastRead = Date.now();
    pending = fetch('/api/operator-asks').then(r => (r.ok ? r.json() : null)).then(rows => {
        if (!Array.isArray(rows)) return; // refused or failed: what is drawn stays (a viewer who may not read it has none)
        const next = rows.filter(a => a && typeof a.board === 'string' && typeof a.asker === 'string' && Number.isFinite(Number(a.id)));
        if (JSON.stringify(next) === JSON.stringify(asks)) return;
        asks = next;
        fire();
    }).catch(() => {}).finally(() => { pending = null; });
    return pending;
}

/** Post the reply as the Operator. An ask is answered with reply_to; either way the asker is @named so the board tells it. Rejects with the server's words when the post is refused. */
export async function replyToAsk(a, text) {
    const body = String(text || '').trim();
    if (!body) throw new Error('Write a reply first.');
    const content = `@${a.asker} ${body}`;
    const resp = await fetch(`/api/board/${encodeURIComponent(a.board)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content, ...(a.kind === 'ask' ? { reply_to: a.id } : {}) }),
    });
    if (!resp.ok) {
        let why = '';
        try { const b = await resp.json(); if (b && typeof b.error === 'string') why = b.error; } catch { /* not JSON */ }
        throw new Error(why ? `Not sent: ${why}` : `Not sent (HTTP ${resp.status}).`);
    }
    asks = asks.filter(x => askKey(x) !== askKey(a)); // gone at once; the next read confirms it
    fire();
    refreshOperatorAsks(true);
}

/** The question whole, with a Reply box: a modal dialog (focus kept inside it, Escape closes it). */
export function openAskDialog(a, onDone) {
    const dlg = document.createElement('dialog');
    dlg.className = 'inbox-ask-dialog';
    dlg.setAttribute('aria-labelledby', 'inbox-ask-title');
    const title = document.createElement('h2'); title.id = 'inbox-ask-title'; title.textContent = `${a.asker} asks you`;
    const sub = document.createElement('p'); sub.className = 'inbox-ask-sub'; sub.textContent = `On the ${a.board} board${a.kind === 'wait' ? ', waiting for your reply' : ''}.`;
    const whole = document.createElement('pre'); whole.className = 'inbox-ask-text'; whole.tabIndex = 0; whole.setAttribute('role', 'region'); whole.setAttribute('aria-label', 'The question');
    whole.textContent = askWhole(a) + (a.cut ? '\n… (cut: the board has the rest)' : '');
    const label = document.createElement('label'); label.className = 'inbox-ask-label'; label.textContent = 'Your reply';
    const box = document.createElement('textarea'); box.className = 'field inbox-ask-box'; box.rows = 4; box.maxLength = 8000; label.append(box);
    const err = document.createElement('p'); err.className = 'inbox-ask-error'; err.setAttribute('role', 'alert');
    const row = document.createElement('div'); row.className = 'inbox-ask-buttons';
    const send = document.createElement('button'); send.type = 'button'; send.className = 'btn btn-primary'; send.textContent = 'Send reply';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close';
    row.append(send, close);
    dlg.append(title, sub, whole, label, err, row);
    const finish = () => { dlg.close(); dlg.remove(); if (onDone) onDone(); };
    close.addEventListener('click', finish);
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    send.addEventListener('click', async () => {
        err.textContent = ''; send.disabled = true;
        try { await replyToAsk(a, box.value); finish(); }
        catch (e) { err.textContent = e.message || 'Not sent.'; send.disabled = false; box.focus(); } // the text stays
    });
    document.body.append(dlg);
    dlg.showModal();
    box.focus();
    return dlg;
}
