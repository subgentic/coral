/* Edit instructions (#10133, Beta Tester #10130): the text an agent is given each time it starts, its Behavior prompt, edited from its row's menu. It is saved for the next restart and the running agent is not touched; the dialog says so
 * above the box and in the toast. A native <dialog> like the reminder's: Escape closes it, Tab stays inside, the focus goes back to what opened it. A refusal is said in the dialog and it stays open. An empty box clears the instructions. */
const MAX_BYTES = 20000;
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let dialog = null;
const close = () => { if (dialog && dialog.open) dialog.close(); };
const bytes = s => new TextEncoder().encode(s).length;

/** Open the dialog for the agent called `label`. opts: current (the saved text), onSave(text) -> Promise<{ ok, error }>, opener (the button, to take the focus back). */
export function openInstructionsDialog(label, opts) {
    if (!dialog) {
        dialog = mk('dialog', 'modal-content dlg-form reminder-dialog instructions-dialog');
        dialog.id = 'instructions-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'instructions-title');
        dialog.addEventListener('cancel', e => { if (dialog.dataset.busy) e.preventDefault(); }); // Escape does not drop a save in flight
        document.body.appendChild(dialog);
    }
    close();
    dialog.replaceChildren();
    const head = mk('div', 'modal-header'); const h = mk('h3', null, `Edit instructions: ${label}`); h.id = 'instructions-title'; head.append(h);
    const form = mk('form', 'modal-body reminder-form'); form.id = 'instructions-form'; form.noValidate = true;
    const lead = mk('p', 'settings-hint', 'What this agent is told each time it starts. Saved now; it takes effect the next time the agent restarts.'); lead.id = 'instructions-lead';
    const box = mk('textarea'); box.id = 'instructions-text'; box.rows = 10; box.value = opts.current || ''; box.setAttribute('aria-label', 'Instructions'); box.setAttribute('aria-describedby', 'instructions-lead');
    const err = mk('div', 'field-error'); err.hidden = true; err.setAttribute('role', 'alert');
    form.append(lead, box, err);
    const acts = mk('div', 'modal-actions modal-footer');
    const cancel = mk('button', 'btn', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    const save = mk('button', 'btn btn-primary', 'Save'); save.type = 'submit'; save.setAttribute('form', 'instructions-form');
    acts.append(cancel, save);
    dialog.append(head, form, acts);
    dialog.addEventListener('close', () => { if (opts.opener && opts.opener.isConnected) opts.opener.focus({ preventScroll: true }); }, { once: true });
    form.addEventListener('submit', async e => {
        e.preventDefault();
        err.hidden = true;
        if (bytes(box.value) > MAX_BYTES) { err.textContent = `That is too long: at most ${MAX_BYTES.toLocaleString('en-US')} bytes (a plain letter is one byte; an accented letter or an emoji is more).`; err.hidden = false; box.setAttribute('aria-invalid', 'true'); box.focus(); return; }
        box.removeAttribute('aria-invalid');
        save.disabled = true; cancel.disabled = true; dialog.dataset.busy = '1';
        let res;
        try { res = await opts.onSave(box.value.trim()); } catch (x) { res = { ok: false, error: (x && x.message) || 'Could not save the instructions.' }; }
        save.disabled = false; cancel.disabled = false; delete dialog.dataset.busy;
        if (res && res.ok) { close(); return; }
        err.textContent = (res && res.error) || 'Could not save the instructions.'; err.hidden = false;
        save.focus();
    });
    dialog.showModal();
    box.focus();
}
