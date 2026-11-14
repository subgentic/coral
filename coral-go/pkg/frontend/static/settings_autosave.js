/* Main Settings persists one row at a time. Chief and Dropbox have their own save flows. */
import { importOnce } from './import_once.js';
import { browserLocal } from './safe_storage.js';
const { readSettingsForm } = await importOnce('./settings_form.js');
const { saveSettingsRow } = await importOnce('./settings_save.js');

const values = new WeakMap(), timers = new WeakMap();
const textField = e => e.matches('textarea,input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])');
const controls = e => e.type === 'radio' ? [...e.closest('.sv-row').querySelectorAll('input[type=radio]')] : [e];
const read = e => controls(e).map(i => i.type === 'checkbox' || i.type === 'radio' ? i.checked : i.value);
const write = (e, v) => controls(e).forEach((i, n) => { if (i.type === 'checkbox' || i.type === 'radio') i.checked = v[n]; else i.value = v[n]; });
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function remember(e) { const v = read(e); for (const i of controls(e)) values.set(i,v); }
function eligible(e) {
    return e?.matches?.('input,select,textarea') && !e.disabled && !e.readOnly &&
        !e.closest('#settings-pane-chief,#settings-dropbox,.cm-form,#settings-security,.settings-cloud-connect') &&
        !e.id.startsWith('settings-dropbox-') && !!e.closest('.sv-row');
}
function status(row) {
    let s = row.querySelector('.settings-save-status');
    if (!s) { s = document.createElement('span'); s.className = 'settings-save-status'; s.setAttribute('role','status'); s.setAttribute('aria-live','polite'); s.setAttribute('aria-atomic','true'); (row.querySelector('.sv-text') || row).append(s); }
    return s;
}
function say(row, text, error = false) {
    const s = status(row); clearTimeout(timers.get(row)); s.toggleAttribute('data-error',error); s.textContent = text;
    if (text === 'Saved') timers.set(row,setTimeout(() => { s.textContent = ''; },2000));
}
async function persist(e) {
    if (!eligible(e) || e.dataset.saving === '1') return;
    const before = values.get(e), after = read(e), row = e.closest('.sv-row');
    if (!before || same(before,after)) return;
    // Derive the payload with only this control changed, including aliases (Antigravity/Gemini)
    // and compound choices (built-in/custom theme). Never submit a neighbouring unfinished field.
    const now = readSettingsForm(true).payload;
    write(e,before); const old = readSettingsForm(true).payload; write(e,after);
    const payload = Object.fromEntries(Object.entries(now).filter(([k,v]) => !same(v,old[k])));
    if (e.id === 'settings-permission-mode' && e.value) payload.default_permission_mode = e.value;
    const special = ['tb-choice','tb-autowake-on','tb-autowake-cap','settings-database-encryption','settings-check-updates','settings-update-auto','settings-update-auto-install','uc-approved','uc-agentic'].includes(e.id);
    const invalid = textField(e) && (!e.checkValidity() || (e.id === 'settings-auto-sleep-minutes' && (!/^\d+$/.test(e.value) || Number(e.value)<15 || Number(e.value)>1440)));
    if (!special && !Object.keys(payload).length && !invalid) { remember(e); return; } // separately persisted local/security controls keep their own handlers
    e.dataset.saving = '1'; const group = controls(e); group.forEach(i => { i.disabled = true; });
    say(row,'');
    try {
        if (invalid) throw new Error('invalid');
        if (e.id === 'settings-database-encryption') {
            // Its saver honours disabled state: unlock only for this scoped request.
            e.disabled = false; const m = await importOnce('./settings_machine.js'); await m.saveDatabaseEncryptionSettings(); e.disabled = true;
        } else if (e.id.startsWith('tb-')) {
            const m = await importOnce('./terminal_backend.js');
            if (!(await m.saveTerminalRow(e.id))) throw new Error('backend');
        } else if (e.id === 'settings-check-updates') {
            browserLocal.set('coral-update-check-enabled',e.checked?'true':'false');
        } else if (['settings-update-auto','settings-update-auto-install','uc-approved','uc-agentic'].includes(e.id)) {
            await (await importOnce('./update_settings.js')).saveUpdateRow(e.id);
        } else await saveSettingsRow(payload);
        remember(e); say(row,'Saved');
    } catch (error) {
        write(e,before); remember(e);
        e.dispatchEvent(new Event('input', {bubbles:true}));
        e.dispatchEvent(new Event('change', {bubbles:true})); // repaint dependent help/rows while saving blocks another request
        say(row,error?.userMessage ? `Not saved. ${error.userMessage} Try again.` : 'Not saved. Try again.',true);
        if (e.id === 'settings-theme') (await importOnce('./settings_core.js')).restoreSavedTheme().catch(() => {});
    } finally { group.forEach(i => { i.disabled = false; }); delete e.dataset.saving; }
}
export function wireSettingsAutosave(modal) {
    for (const e of modal.querySelectorAll('input,select,textarea')) if (eligible(e)) { remember(e); status(e.closest('.sv-row')); }
    if (modal.dataset.autosave) return;
    modal.dataset.autosave = '1';
    // Focus/pointer snapshots include controls loaded asynchronously after the dialog opens.
    for (const type of ['focusin','pointerdown']) modal.addEventListener(type,e => { if (eligible(e.target) && e.target.dataset.saving !== '1' && (type !== 'pointerdown' || e.target !== document.activeElement)) remember(e.target); });
    // A model dropdown only sets the text box the form reads; the box is the control that saves (the dropdown itself has no value of its own in the payload, so saving it found nothing changed: Haiku went back to the CLI's default, #16667)
    const boxOf = e => e.classList.contains('settings-model-pick') ? document.getElementById(e.id.replace('settings-model-pick-', 'settings-default-model-')) : null;
    modal.addEventListener('change', e => {
        const box = boxOf(e.target);
        if (box) { if (e.target.value !== '__other__') persist(box); return; }
        if (eligible(e.target) && !textField(e.target)) persist(e.target);
    });
    modal.addEventListener('focusout', e => { if (eligible(e.target) && textField(e.target)) persist(e.target); });
    modal.addEventListener('keydown', e => { if (e.key === 'Enter' && eligible(e.target) && textField(e.target) && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); persist(e.target); } });
}
