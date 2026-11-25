/* The dialog the Agents tab's "Remind <name>" opens (UI/UX's #99792): the Message (what the agent is reminded of, prefilled), Repeat (not by default; every 30 minutes, hour, 4 hours or day), and Remind, which has the focus so Enter sends.
 * It is a native <dialog> opened with showModal(): Escape closes it, Tab stays inside, and the focus goes back to the button that opened it. The message is ONE line to the agent (the server delivers it through board.OneLine),
 * so it is normalised the same way as it is sent. A refusal is said in the dialog and the dialog stays open. */
import { importOnce } from './import_once.js';
import { el as mk } from './dom_el.js';
const { oneLine } = await importOnce('./reminder_dialog.js');
const { checkCron, nextRun } = await importOnce('./reminder_cron.js'); // the Custom (cron) line's check, the server's rules (#21330)
const { cronWords, atWords, localZone } = await importOnce('./job_words.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried

export const REPEATS = [[0, "Don't repeat", ''], [1800, 'Every 30 minutes', 'every 30 minutes'], [3600, 'Every hour', 'every hour'], [14400, 'Every 4 hours', 'every 4 hours'], [86400, 'Every day', 'every day']];
export const CUSTOM = 'cron'; // the Repeat choice that takes a cron line (#21330)
const DEFAULT_MESSAGE = 'Check your tasks and the board, then carry on.';
const MAX_MESSAGE = 1000;

let dialog = null;
const close = () => { if (dialog && dialog.open) dialog.close(); };

/** Open the dialog for `name`. opts: onSend({ message, seconds, cron, timezone }) -> Promise<{ ok, error }> (seconds is 0 for no repeat; for Custom (cron) it is 0, cron is the checked line and timezone this computer's), custom (true: Repeat also has Custom (cron)), opener (the button, to take the focus back). */
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
    // Custom (cron) (#21330): a line of five fields in this computer's time zone, read back in words with the next time it fires; a line the server would refuse is said in one line and Remind stays off
    let cronBox = null, cronInput = null, cronWords_ = null, cronErr = null;
    if (opts.custom) {
        const o = mk('option', null, 'Custom (cron)'); o.value = CUSTOM; repeat.append(o);
        cronBox = mk('div', 'remind-cron'); cronBox.hidden = true;
        const cl = mk('label', null, 'Cron line'); cl.htmlFor = 'remind-cron';
        cronInput = mk('input', 'remind-cron-input'); cronInput.id = 'remind-cron'; cronInput.type = 'text'; cronInput.placeholder = '0 9 * * 1-5'; cronInput.autocomplete = 'off'; cronInput.spellcheck = false; cronInput.maxLength = 100;
        cronInput.setAttribute('aria-describedby', 'remind-cron-words remind-cron-error');
        cronWords_ = mk('div', 'reminder-hint remind-cron-words'); cronWords_.id = 'remind-cron-words'; cronWords_.setAttribute('role', 'status');
        cronErr = mk('div', 'field-error remind-cron-error'); cronErr.id = 'remind-cron-error'; cronErr.hidden = true;
        cronBox.append(cl, cronInput, mk('div', 'reminder-hint', `Minute hour day month weekday, in this computer's time zone (${localZone()}). At most every 5 minutes.`), cronWords_, cronErr);
    }
    const serverErr = mk('div', 'field-error reminder-server-error'); serverErr.hidden = true; serverErr.setAttribute('role', 'alert');
    form.append(ml, message, mhint, messageErr, rl, repeat, ...(cronBox ? [cronBox] : []), serverErr);
    const acts = mk('div', 'modal-actions modal-footer');
    const cancel = mk('button', 'btn remind-cancel', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    const go = mk('button', 'btn btn-primary remind-go', 'Remind'); go.type = 'submit'; go.setAttribute('form', 'remind-form'); go.autofocus = true; // the footer is the card's child, outside the form, as in every dialog
    acts.append(cancel, go);
    dialog.append(head, form, acts);
    /** Reads the line back: the words and the next run, or why it will not do (and Remind off). Returns the checked line, or '' when there is none to send. */
    const readCron = () => {
        if (!cronBox) return '';
        const on = repeat.value === CUSTOM; cronBox.hidden = !on;
        if (!on) { go.disabled = false; return ''; }
        const text = cronInput.value.trim();
        const c = text ? checkCron(text) : { ok: false, error: '' };
        cronWords_.textContent = ''; cronErr.hidden = true; cronInput.removeAttribute('aria-invalid');
        if (c.ok) {
            const next = nextRun(c.line);
            cronWords_.textContent = `${cronWords(c.line)}${next ? ` · next ${atWords(next.toISOString())}` : ''}`;
        } else if (text) { cronErr.textContent = c.error; cronErr.hidden = false; cronInput.setAttribute('aria-invalid', 'true'); }
        go.disabled = !c.ok;
        return c.ok ? c.line : '';
    };
    if (cronBox) { repeat.addEventListener('change', () => { readCron(); if (repeat.value === CUSTOM) cronInput.focus(); }); cronInput.addEventListener('input', readCron); }
    message.addEventListener('input', () => { if (message.value.trim()) { messageErr.hidden = true; message.removeAttribute('aria-invalid'); } });
    dialog.addEventListener('close', () => { if (opts.opener && opts.opener.isConnected) opts.opener.focus({ preventScroll: true }); }, { once: true });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        serverErr.hidden = true;
        const text = oneLine(message.value);
        if (!text) { messageErr.textContent = 'Write what the agent should be reminded of.'; messageErr.hidden = false; message.setAttribute('aria-invalid', 'true'); message.focus(); return; }
        const cron = readCron();
        if (repeat.value === CUSTOM && !cron) { cronInput.focus(); return; }
        message.value = text;
        go.disabled = true; cancel.disabled = true; dialog.dataset.busy = '1';
        let res;
        try { res = await opts.onSend({ message: text, seconds: cron ? 0 : Number(repeat.value), ...(cron ? { cron, timezone: localZone() } : {}) }); } catch (err) { res = { ok: false, error: (err && err.message) || 'Could not send the reminder.' }; }
        go.disabled = false; cancel.disabled = false; delete dialog.dataset.busy; readCron();
        if (res && res.ok) { close(); return; }
        serverErr.textContent = (res && res.error) || 'Could not send the reminder.'; serverErr.hidden = false;
        go.focus();
    });
    dialog.showModal();
}
