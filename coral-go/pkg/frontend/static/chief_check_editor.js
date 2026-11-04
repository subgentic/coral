/* The check editor keeps refused/unsaved instructions in the form for correction. */
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
const { INTERVALS, NOTIFY_MODES } = await importOnce('./chief_checks_model.js');
const { saveCheck } = await importOnce('./chief_checks_api.js');

export function editCheck(check, agents, onSaved) {
    const dialog = el('dialog', 'modal-content dlg-form chief-check-editor');
    dialog.setAttribute('aria-labelledby', 'chief-check-editor-title');
    const heading = el('h2', '', check.id ? 'Edit check' : 'New check'); heading.id = 'chief-check-editor-title';
    const form = el('form', 'chief-check-form');
    let dirty = false, busy = false;
    const fields = {};
    function field(key, label, tag = 'input', options) {
        const wrap = el('label', 'chief-check-field', label), input = el(tag);
        input.name = key;
        if (tag === 'select') for (const [value, word] of options) { const o = el('option', '', word); o.value = String(value); input.append(o); }
        if (tag === 'input') input.type = 'text';
        input.value = String(check[key] ?? ''); wrap.append(input); fields[key] = input; form.append(wrap); return input;
    }
    field('name', 'Name').maxLength = 120;
    const instruction = field('instruction', 'Instruction', 'textarea'); instruction.rows = 5; instruction.required = true;
    fields.name.required = true;
    form.append(el('p', 'chief-check-hint', 'Use the agent’s own connectors. Do not paste passwords, tokens or sign-in links.'));
    const agent = field('target_session', 'Receiving agent', 'select', agents.map(a => [a.session_id, `${a.display_name || a.name} · ${a.board_label || a.board_project}`]));
    if (check.target_session && !agents.some(a => a.session_id === check.target_session)) {
        const missing = el('option', '', 'Original agent is unavailable — choose an agent'); missing.value = check.target_session; agent.prepend(missing); agent.value = check.target_session;
    }
    field('schedule_kind', 'Schedule', 'select', [['interval', 'Repeat'], ['daily', 'Daily'], ['weekdays', 'Weekdays']]);
    field('every_minutes', 'Check every', 'select', INTERVALS);
    field('at', 'Time').type = 'time';
    field('timezone', 'Timezone').required = true;
    field('notify_mode', 'Tell me', 'select', NOTIFY_MODES);
    for (const [key, word] of [['enabled', 'Schedule enabled'], ['wake_if_asleep', 'Wake the agent if it is asleep']]) {
        const label = el('label', 'chief-check-checkbox'); const input = el('input'); input.type = 'checkbox'; input.name = key; input.checked = check[key] === true; fields[key] = input; label.append(input, document.createTextNode(word)); form.append(label);
    }
    form.append(el('p', 'chief-check-hint', 'Waking is off by default. When enabled, ordinary permission and team limits still apply.'));
    const error = el('p', 'chief-check-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const footer = el('div', 'chief-check-actions');
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    const discard = el('button', 'btn', 'Discard changes'); discard.type = 'button'; discard.hidden = true;
    const save = el('button', 'btn btn-primary', 'Save check'); save.type = 'submit';
    footer.append(error, cancel, discard, save); form.append(footer); dialog.append(heading, form);
    const closing = () => {
        if (busy) return;
        if (dirty) { error.hidden = false; error.textContent = 'You have unsaved changes. Keep editing or discard them.'; discard.hidden = false; discard.focus(); }
        else dialog.close();
    };
    cancel.addEventListener('click', closing); discard.addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closing(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) closing(); });
    dialog.addEventListener('close', () => dialog.remove());
    const scheduleVisibility = () => { const repeating = fields.schedule_kind.value === 'interval'; fields.every_minutes.parentElement.hidden = !repeating; fields.at.parentElement.hidden = repeating; };
    fields.schedule_kind.addEventListener('change', scheduleVisibility); scheduleVisibility();
    form.addEventListener('input', () => { dirty = true; }); form.addEventListener('change', () => { dirty = true; });
    form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy || !form.reportValidity()) return;
        const chosen = agents.find(a => a.session_id === agent.value);
        if (!chosen) { error.hidden = false; error.textContent = 'Choose an available agent before saving.'; return; }
        const spec = { ...check };
        for (const [key, input] of Object.entries(fields)) spec[key] = input.type === 'checkbox' ? input.checked : input.value;
        spec.every_minutes = Number(spec.every_minutes); spec.target_board = chosen.board_project;
        busy = true; save.disabled = true; cancel.disabled = true; discard.disabled = true; error.hidden = true; form.setAttribute('aria-busy', 'true');
        try { const saved = await saveCheck(spec); await onSaved(saved); dirty = false; dialog.close(); }
        catch (e) { error.hidden = false; error.textContent = e.message || 'The check was not saved. Try again.'; }
        finally { busy = false; save.disabled = false; cancel.disabled = false; discard.disabled = false; form.removeAttribute('aria-busy'); }
    });
    document.body.append(dialog); dialog.showModal(); fields.name.focus();
    return dialog;
}
