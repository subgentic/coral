/* The dialog the Agents tab's "Remind <name>" opens (UI/UX's #99792): the Message (what the agent is reminded of, prefilled), Repeat (not by default; every 30 minutes, hour, 4 hours or day), and Remind, which has the focus so Enter sends.
 * It is a native <dialog> opened with showModal(): Escape closes it, Tab stays inside, and the focus goes back to the button that opened it. The message is ONE line to the agent (the server delivers it through board.OneLine),
 * so it is normalised the same way as it is sent. A refusal is said in the dialog and the dialog stays open. */
import { importOnce } from './import_once.js';
const { oneLine } = await importOnce('./reminder_dialog.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried

export const REPEATS = [[0, "Don't repeat", ''], [1800, 'Every 30 minutes', 'every 30 minutes'], [3600, 'Every hour', 'every hour'], [14400, 'Every 4 hours', 'every 4 hours'], [86400, 'Every day', 'every day']];
const DEFAULT_MESSAGE = 'Check your tasks and the board, then carry on.';
const MAX_MESSAGE = 1000;

const { el: mk } = await importOnce('./dom_el.js');
let dialog = null;
const close = () => { if (dialog && dialog.open) dialog.close(); };

/** Open the dialog for `name`. opts: onSend({ message, seconds }) -> Promise<{ ok, error }> (seconds is 0 for no repeat), opener (the button, to take the focus back). */
export function openRemindDialog(name, opts) {
    if (!dialog) {
        dialog = mk('dialog', 'modal-content dlg-confirm reminder-dialog remind-dialog');
        dialog.id = 'remind-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'remind-title');
        dialog.addEventListener('cancel', (e) => { if (dialog.dataset.busy) e.preventDefault(); }); // Escape does not drop a request in flight
        document.body.appendChild(dialog);
    }
    close();
    dialog.replaceChildren();
    const head = mk('div', 'modal-header'); const h = mk('h3', null, `Remind ${name}`); h.id = 'remind-title'; head.append(h);
    const form = mk('form', 'modal-body reminder-form'); form.id = 'remind-form'; form.noValidate = true;
    const ml = mk('label', null, 'Message'); ml.htmlFor = 'remind-message';
    const message = mk('textarea'); message.id = 'remind-message'; message.rows = 3; message.maxLength = MAX_MESSAGE; message.value = DEFAULT_MESSAGE; message.setAttribute('aria-describedby', 'remind-message-hint');
    const mhint = mk('div', 'reminder-hint', 'Sent to the agent now, as one line.'); mhint.id = 'remind-message-hint';
    const messageErr = mk('div', 'field-error'); messageErr.id = 'remind-message-error'; messageErr.hidden = true;
    const rl = mk('label', null, 'Repeat'); rl.htmlFor = 'remind-repeat';
    const repeat = mk('select'); repeat.id = 'remind-repeat';
    for (const [secs, word] of REPEATS) { const o = mk('option', null, word); o.value = String(secs); repeat.append(o); }
    const serverErr = mk('div', 'field-error reminder-server-error'); serverErr.hidden = true; serverErr.setAttribute('role', 'alert');
    form.append(ml, message, mhint, messageErr, rl, repeat, serverErr);
    const acts = mk('div', 'modal-actions modal-footer');
    const cancel = mk('button', 'btn remind-cancel', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    const go = mk('button', 'btn btn-primary remind-go', 'Remind'); go.type = 'submit'; go.setAttribute('form', 'remind-form'); go.autofocus = true; // the footer is the card's child, outside the form, as in every dialog
    acts.append(cancel, go);
    dialog.append(head, form, acts);
    message.addEventListener('input', () => { if (message.value.trim()) { messageErr.hidden = true; message.removeAttribute('aria-invalid'); } });
    dialog.addEventListener('close', () => { if (opts.opener && opts.opener.isConnected) opts.opener.focus({ preventScroll: true }); }, { once: true });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        serverErr.hidden = true;
        const text = oneLine(message.value);
        if (!text) { messageErr.textContent = 'Write what the agent should be reminded of.'; messageErr.hidden = false; message.setAttribute('aria-invalid', 'true'); message.focus(); return; }
        message.value = text;
        go.disabled = true; cancel.disabled = true; dialog.dataset.busy = '1';
        let res;
        try { res = await opts.onSend({ message: text, seconds: Number(repeat.value) }); } catch (err) { res = { ok: false, error: (err && err.message) || 'Could not send the reminder.' }; }
        go.disabled = false; cancel.disabled = false; delete dialog.dataset.busy;
        if (res && res.ok) { close(); return; }
        serverErr.textContent = (res && res.error) || 'Could not send the reminder.'; serverErr.hidden = false;
        go.focus();
    });
    dialog.showModal();
}
