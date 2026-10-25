/* Held messages the person should know about (#6473, the dashboard side of #6466): Coral holds an agent's automated input (board nudges, reminders) while a prompt or menu is open or the CLI's input box
 * is not on screen (held_inputs on the live row, #3578). A few seconds is the gate doing its job; past a minute Coral cannot see the input box and the messages are not getting through, so the row and the
 * agent view say so, with the terminal one click away. The agent view also has Send now (held_send_now.js, #7554), the Operator's way to deliver them at once. The row has the count and no time, so the minute is counted from when this page first saw
 * the agent holding (a `held_since` on the row, when the server sends one, is the start instead). */
export const HELD_AFTER_MS = 60 * 1000;
const firstHeld = new Map(); // session_id -> ms when this page first saw it holding

const afterMs = () => { const o = Number(typeof window !== 'undefined' && window.__coralHeldAfterMs); return Number.isFinite(o) && o >= 0 && typeof window.__coralHeldAfterMs !== 'undefined' ? o : HELD_AFTER_MS; };

/** held_inputs as a safe non-negative integer. */
export function heldCount(row) {
    const n = Number(row && row.held_inputs);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 999) : 0;
}

/** What is said of why the messages wait, by the row's held_reason (#7433). Only "box" says Coral cannot see the input box: a long turn, an open question, a dialog and a draft each have their own words. A row
 * with no reason, or a word this page does not know, says only that they wait. */
const WHY = {
    turn: n => `${n} message${n === 1 ? '' : 's'} will arrive when this agent's turn ends`,
    prompt: n => `${n} message${n === 1 ? '' : 's'} waiting: this agent is asking for an answer`,
    dialog: n => `${n} message${n === 1 ? '' : 's'} waiting: a dialog is open in its terminal`,
    draft: n => `${n} message${n === 1 ? '' : 's'} waiting: there is a draft in its input box`,
    box: n => `${n} message${n === 1 ? '' : 's'} waiting: Coral can't see the input box`,
};
const heldText = (n, reason) => (Object.hasOwn(WHY, reason) ? WHY[reason] : n2 => `${n2} message${n2 === 1 ? '' : 's'} waiting to be delivered`)(n);

/** { n, text } when the agent has held input for more than a minute, else null. */
export function heldNotice(row, now = Date.now()) {
    const id = row && row.session_id;
    const n = heldCount(row);
    if (!id || n <= 0 || row.sleeping) { if (id) firstHeld.delete(id); return null; }
    let since = Date.parse(row.held_since || '');
    if (!Number.isFinite(since)) { if (!firstHeld.has(id)) firstHeld.set(id, now); since = firstHeld.get(id); }
    if (now - since <= afterMs()) return null;
    return { n, text: heldText(n, row.held_reason) };
}

/** The agent view's line: the words and a Show terminal button, while the open agent holds; hidden otherwise. */
export function syncHeldNotice(row) {
    const el = document.getElementById('composer-held-notice');
    if (!el) return;
    const note = heldNotice(row);
    // The status (#composer-held-text) is always in the page and only its text changes, so what is put into it is read; the line takes no room while it is empty, and Show terminal is there only with it.
    // Written only on a change: a feed message that changes nothing drawn writes nothing to the page (#5010's budget, perf_budgets check 7).
    const t = document.getElementById('composer-held-text');
    if (t && t.textContent !== (note ? note.text : '')) t.textContent = note ? note.text : '';
    const b = el.querySelector('button');
    if (b && b.hidden === !!note) b.hidden = !note;
    // Send now, and the line that says what it does; "Send all now" when more than one is held (#7554).
    const send = document.getElementById('composer-held-send'), hint = document.getElementById('composer-held-hint');
    if (send) {
        if (send.hidden === !!note) send.hidden = !note;
        const label = note && note.n > 1 ? 'Send all now' : 'Send now';
        if (send.textContent !== label) send.textContent = label;
    }
    if (hint && hint.hidden === !!note) hint.hidden = !note;
}
