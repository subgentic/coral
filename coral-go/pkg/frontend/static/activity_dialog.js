/* An answered question in Activity opens as a thread (#15724, the Operator's pick: design B's timeline, one block per message with a name and a time): the agent's question, the Operator's answer and every later reply
 * in order, then a box to reply into the same thread and the way to the Board. Lazy: loaded by the Activity folder when a question's row is opened. A message's words are the agent's, so they are written as text
 * (renderMarkdownStrict writes raw HTML out as text), never inserted as markup. */
import { boardFetch, splitKey } from './server_base.js';
import { fetchMessages } from './board_fetch.js';
import { OPERATOR_ID, renderMarkdownStrict, showToast } from './utils.js';
import { markHidden } from './visible_marks.js';
import { whenText } from './when_text.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('activity_dialog.css');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The messages of the question's thread, in order: the question, then each message that answers one already in it (a reply to an answer is in too). A pure function of the board's messages after the question. */
export function threadOf(messages, askId) {
    const ids = new Set([askId]), out = [];
    for (const m of [...messages].sort((a, b) => a.id - b.id)) {
        if (m.id === askId || (m.reply_to && ids.has(Number(m.reply_to)))) { ids.add(m.id); out.push(m); }
    }
    return out;
}
const mine = m => m.subscriber_id === OPERATOR_ID || m.subscriber_id === 'dashboard';
const nameOf = m => mine(m) ? 'You' : markHidden(m.subscriber_id || 'Agent', { strict: true });

function block(m) {
    const b = el('li', `activity-thread-msg${mine(m) ? ' activity-thread-mine' : ''}`); b.dataset.messageId = String(m.id);
    const head = el('div', 'activity-thread-head'); head.append(el('strong', 'activity-thread-name', nameOf(m)), el('span', 'activity-thread-time', whenText(m.created_at)));
    const body = el('div', 'activity-thread-body prose'); body.innerHTML = renderMarkdownStrict(String(m.content || ''));
    b.append(head, body); return b;
}

/** Open the thread of an answered question: `row` is the record's row (item_id is the question's message, team the board). `onDone` runs when the dialog closes. */
export async function openThread(row, { onDone, openBoard } = {}) {
    const team = row.team, askId = Number(row.item_id), asker = row.asker || row.title || 'the agent';
    const dlg = el('dialog', 'modal-content dlg-flow activity-thread-dialog'); dlg.setAttribute('aria-labelledby', 'activity-thread-title');
    const title = el('h2', null, ''); title.id = 'activity-thread-title';
    const chip = el('span', 'chip activity-thread-chip', row.action === 'answer' ? 'Answered' : 'Question'); title.append(chip, ` ${markHidden(row.title || 'A question', { strict: true })}`);
    const sub = el('p', 'activity-thread-sub', [splitKey(team).name, `from ${markHidden(asker, { strict: true })}`, `decided ${whenText(row.at)}`].join(' · '));
    const list = el('ol', 'activity-thread'); list.setAttribute('aria-label', 'The thread');
    const status = el('p', 'activity-thread-status', 'Reading the thread…'); status.setAttribute('role', 'status');
    const label = el('label', 'activity-thread-label', 'Reply in this thread'); const box = el('textarea', 'field activity-thread-box'); box.rows = 3; box.maxLength = 8000; box.placeholder = 'Reply in this thread…'; label.append(box);
    const err = el('p', 'activity-thread-error'); err.setAttribute('role', 'alert');
    const send = el('button', 'btn btn-primary activity-thread-send', 'Send reply'); send.type = 'button'; send.disabled = true;
    const board = el('button', 'btn btn-small activity-thread-board', 'Open on the Board'); board.type = 'button'; board.hidden = typeof openBoard !== 'function';
    const close = el('button', 'btn btn-small', 'Close'); close.type = 'button';
    const actions = el('div', 'activity-thread-actions'); actions.append(send, board, close);
    dlg.append(title, sub, status, list, label, err, actions); document.body.append(dlg);
    const opener = document.activeElement;
    const finish = () => { dlg.close(); dlg.remove(); if (onDone) onDone(); if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true }); };
    close.addEventListener('click', finish); dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    board.addEventListener('click', () => { finish(); openBoard(row); });
    let thread = [], kept = false; // kept: the record's own words stand in for a thread the board no longer has
    const paint = () => { list.replaceChildren(...thread.map(block)); status.hidden = true; send.disabled = !box.value.trim(); };
    box.addEventListener('input', () => { send.disabled = !box.value.trim(); err.textContent = ''; });
    send.addEventListener('click', async () => {
        const text = box.value.trim(); if (!text) return;
        const parent = thread.length && !kept ? thread[thread.length - 1] : { id: askId, subscriber_id: asker };
        send.disabled = true; err.textContent = '';
        try {
            const resp = await boardFetch(team, '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content: `@${asker} ${text}`, reply_to: parent.id }) });
            if (!resp.ok) { let why = ''; try { const b = await resp.json(); if (b && typeof b.error === 'string') why = b.error; } catch { /* not JSON */ } throw new Error(why ? `Not sent: ${why}` : `Not sent (HTTP ${resp.status}).`); }
            const made = await resp.json().catch(() => ({}));
            thread = [...thread, { id: Number(made.id) || parent.id + 1, subscriber_id: OPERATOR_ID, content: `@${asker} ${text}`, created_at: new Date().toISOString(), reply_to: parent.id }];
            box.value = ''; paint(); list.lastElementChild?.scrollIntoView({ block: 'nearest' }); showToast('Reply sent.');
        } catch (e) { err.textContent = e.message || 'Not sent.'; send.disabled = false; } // the draft stays
    });
    dlg.showModal(); box.focus({ preventScroll: true });
    try {
        const { messages } = await fetchMessages(team, 200, { after_id: Math.max(0, askId - 1) });
        thread = threadOf(messages, askId);
    } catch { thread = []; }
    if (!thread.length) { kept = true; // the board no longer has it: the record's own words say what was asked and answered
        thread = [{ id: askId, subscriber_id: asker, content: row.title || '', created_at: row.at }, ...(row.note ? [{ id: askId + 1, subscriber_id: OPERATOR_ID, content: String(row.note).replace(/^Your answer: /, ''), created_at: row.at }] : [])];
        status.hidden = false; status.textContent = 'The board has no longer got this thread; this is what the record kept.';
        list.replaceChildren(...thread.map(block)); send.disabled = !box.value.trim(); return dlg;
    }
    paint(); return dlg;
}
