/* The New workflow / Edit workflow dialog (#8450): a settings_view in form mode, as New job is. The fields are drawn from the spec below (label above, Required, the first invalid field focused,
 * one status line beside the buttons, the primary always on); what is the workflow's own stays here: the steps editor (its rows, their numbers and names) and the time limit in words. Save keeps
 * every step field the editor does not show (#4423). The ids of the controls are the page's contract and stay. */
import { mountSettingsView } from './settings_view.js';
import { showToast } from './utils.js';
import { registerActions, withId } from './actions.js';
import { apiFetch } from './api.js';
import { importOnce } from './import_once.js';
import { limitSeconds, limitParts } from './time_limit.js';
const { WORKFLOW_TEMPLATES, templateById } = await importOnce('./workflow_templates.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried

let view = null;
let editingWorkflowId = null; // non-null when editing
let returnTo = null; // what to do when the dialog closes, saved or not: New job opened it, and the job form comes back (#9297)
let hooks = { fetchDetail: async () => null, saved: () => {} };

/** workflows.js tells the form how to read a workflow and what to redraw when one is saved (the form imports nothing back from the page). */
export function initWorkflowEditor(h) { hooks = { ...hooks, ...h }; }

const MAX_LIMIT_S = 86400; // the server's ceiling for a workflow's time limit (24 hours)
const DEFAULT_LIMIT_S = 3600;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

/** aria-invalid is "true" or absent: an empty attribute reads as false to a screen reader. */
function markInvalid(e, bad) { if (bad) e.setAttribute('aria-invalid', 'true'); else e.removeAttribute('aria-invalid'); }

// -- the steps editor ------------------------------------------------------------------------------------

// The step each editor row was loaded from: the editor shows only a step's name, type and command or prompt, and Save keeps
// every other field (timeout_s, agent, continue_on_failure, hooks, interactive, output_artifact, and any it doesn't know).
const loadedSteps = new WeakMap();

const contentWord = type => (type === 'shell' ? 'command' : 'prompt');

function stepRow(step) {
    const type = step ? step.type || 'shell' : 'shell';
    const name = step ? step.name || '' : '';
    const content = step ? (type === 'shell' ? step.command || '' : step.prompt || '') : '';
    const item = el('div', 'wf-step-editor-item');
    const top = el('div', 'wf-step-editor-top');
    const select = el('select', 'wf-step-type-select');
    for (const t of ['shell', 'agent']) { const o = el('option', '', t); o.value = t; select.append(o); }
    select.value = type;
    const nameInput = el('input', 'wf-step-name-input'); nameInput.type = 'text'; nameInput.placeholder = 'Step name'; nameInput.value = name;
    const remove = el('button', 'btn btn-quiet btn-icon btn-xs wf-step-remove-btn'); remove.type = 'button'; remove.title = 'Remove step'; { const x = el('span', 'material-icons', 'close'); x.setAttribute('aria-hidden', 'true'); remove.append(x); } // the icon button (#9457): the glyph is the family's, not a typed ×
    const num = el('span', 'wf-step-num'); num.setAttribute('aria-hidden', 'true');
    top.append(num, select, nameInput, remove);
    const body = el('div', 'wf-step-editor-body');
    const textarea = el('textarea', 'wf-step-content'); textarea.rows = 2; textarea.placeholder = type === 'shell' ? 'Shell command...' : 'Agent prompt...'; textarea.value = content;
    body.append(textarea);
    item.append(top, body);
    if (step) loadedSteps.set(item, step);
    return item;
}

function stepsField() {
    return {
        key: 'steps', type: 'custom', id: 'wf-steps-editor', labelId: 'wf-steps-label', label: 'Steps', required: true, requiredMessage: 'Add at least one step.', default: [],
        validate: rows => (problem(rows) || {}).message || '',
        render: slot => {
            slot.setAttribute('role', 'group'); slot.setAttribute('aria-labelledby', 'wf-steps-label');
            const list = el('div', 'wf-step-rows');
            const add = el('button', 'btn btn-sm wf-add-step-btn'); add.type = 'button';
            const plus = el('span', 'material-icons', 'add'); plus.setAttribute('aria-hidden', 'true'); plus.style.fontSize = 'var(--fs-lg)';
            add.append(plus, ' Add step');
            slot.append(list, add);
            const items = () => [...list.querySelectorAll('.wf-step-editor-item')];
            // Each step's controls carry its number, so "Remove step 2" and "Step 2 command" tell the rows apart; renumbered when one is removed.
            const nameControls = () => items().forEach((item, i) => {
                const n = i + 1, type = item.querySelector('.wf-step-type-select').value;
                item.querySelector('.wf-step-num').textContent = `Step ${n}`;
                item.querySelector('.wf-step-type-select').setAttribute('aria-label', `Step ${n} type`);
                item.querySelector('.wf-step-name-input').setAttribute('aria-label', `Step ${n} name`);
                item.querySelector('.wf-step-remove-btn').setAttribute('aria-label', `Remove step ${n}`);
                item.querySelector('.wf-step-content').setAttribute('aria-label', `Step ${n} ${contentWord(type)}`);
            });
            const addRow = step => { const item = stepRow(step); list.append(item); nameControls(); return item; };
            add.addEventListener('click', () => { const item = addRow(); item.querySelector('.wf-step-name-input').focus(); view && view.refresh(); });
            list.addEventListener('change', e => {
                if (!e.target.classList.contains('wf-step-type-select')) return;
                e.target.closest('.wf-step-editor-item').querySelector('.wf-step-content').placeholder = e.target.value === 'shell' ? 'Shell command...' : 'Agent prompt...';
                nameControls();
            });
            list.addEventListener('click', e => { const b = e.target.closest('.wf-step-remove-btn'); if (b) { b.closest('.wf-step-editor-item').remove(); nameControls(); view && view.refresh(); } });
            list.addEventListener('input', e => { const f = e.target; if (f.getAttribute('aria-invalid')) markInvalid(f, false); }); // typing in a marked field clears its mark (#6348)
            const rows = () => items().map(item => ({
                item,
                type: item.querySelector('.wf-step-type-select').value,
                name: item.querySelector('.wf-step-name-input').value.trim(),
                content: item.querySelector('.wf-step-content').value.trim(),
            }));
            return {
                get: rows,
                set: steps => { list.replaceChildren(); for (const s of (steps && steps.length ? steps : [null])) addRow(s); }, // a new workflow starts with one empty step
                invalid: on => { for (const f of list.querySelectorAll('[aria-invalid]')) markInvalid(f, false); const p = on && problem(rows()); if (p) markInvalid(p.control, true); },
                focus: () => { const p = problem(rows()); (p ? p.control : list.querySelector('.wf-step-name-input'))?.focus(); },
            };
        },
    };
}

/** The first step with something missing: what to say, and the control to focus. */
function problem(rows) {
    let at = 0;
    for (const r of rows || []) {
        at++;
        if (!r.name) return { message: `Step ${at} needs a name.`, control: r.item.querySelector('.wf-step-name-input') };
        if (!r.content) return { message: `Step ${at} (${r.name}) needs a ${contentWord(r.type)}.`, control: r.item.querySelector('.wf-step-content') };
    }
    return null;
}

// -- the time limit: a number and a unit, read as seconds -------------------------------------------------

function limitField() {
    return {
        key: 'max_duration_s', type: 'custom', id: 'wf-limit', labelId: 'wf-limit-label', label: 'Time limit', default: DEFAULT_LIMIT_S,
        validate: v => (v && v.error) || '',
        render: slot => {
            slot.setAttribute('role', 'group'); slot.setAttribute('aria-labelledby', 'wf-limit-label');
            const wrap = el('span', 'wf-limit-fields');
            const n = el('input'); n.type = 'number'; n.id = 'wf-input-max-dur'; n.value = '1'; n.min = '1'; n.step = '1'; n.setAttribute('inputmode', 'numeric'); n.setAttribute('aria-label', 'Time limit');
            const unit = el('select'); unit.id = 'wf-input-max-dur-unit'; unit.setAttribute('aria-label', 'Time limit unit');
            for (const [value, label] of [['3600', 'hours'], ['60', 'minutes'], ['1', 'seconds']]) { const o = el('option', '', label); o.value = value; unit.append(o); }
            unit.value = '3600';
            wrap.append(n, unit); slot.append(wrap);
            const live = () => { const r = limitSeconds(n.value, unit.value, MAX_LIMIT_S); markInvalid(n, !!r.error); if (view) view.error('max_duration_s', r.error || ''); }; // the sentence is said as it is typed, not only when Create is pressed
            n.addEventListener('input', live); unit.addEventListener('change', live);
            return {
                get: () => limitSeconds(n.value, unit.value, MAX_LIMIT_S),
                set: seconds => { const p = limitParts(seconds || DEFAULT_LIMIT_S); n.value = String(p.n); unit.value = String(p.unit); markInvalid(n, false); },
                invalid: on => markInvalid(n, on),
                focus: () => n.focus(),
            };
        },
    };
}

// -- the fields -------------------------------------------------------------------------------------------

// The first step a new workflow starts with: a named one to fill in, so the form shows what a step is for (#9297). Its command is empty with an example as the placeholder, so nothing runnable is saved by accident.
const EXAMPLE_STEP = { name: 'Run tests', type: 'shell', command: '' };
const EXAMPLE_COMMAND = 'e.g. npm test';
const TEMPLATE_NONE = '';

function workflowFields() {
    return [
        {
            key: 'build_hint', type: 'notice',
            render: slot => {
                slot.id = 'wf-build-hint'; slot.classList.add('wf-build-hint');
                const b = el('button', 'btn btn-small', 'Build with Agent'); b.type = 'button'; b.setAttribute('data-on-click', 'wf-build-agent-from-form');
                slot.append(el('span', '', 'Not sure what the steps are? An agent can write them with you.'), ' ', b);
            },
        },
        {
            key: 'template', type: 'select', id: 'wf-input-template', label: 'Start from a template', help: 'Fills the name and steps of an example for you to change; nothing is saved until Create workflow.',
            options: [{ value: TEMPLATE_NONE, label: 'A blank workflow' }, ...WORKFLOW_TEMPLATES.map(t => ({ value: t.id, label: t.label }))],
            setup: sel => sel.addEventListener('change', () => applyTemplate(sel.value)),
        },
        { key: 'name', type: 'text', id: 'wf-input-name', label: 'Name', required: true, requiredMessage: 'Give the workflow a name.', placeholder: 'lint-and-fix', help: 'Letters, numbers, hyphens and underscores.', attrs: { pattern: '[a-zA-Z0-9_-]+' } },
        stepsField(),
        { key: 'extras', type: 'heading', fold: true, id: 'wf-more', label: 'More options' },
        { key: 'description', type: 'text', id: 'wf-input-desc', label: 'Description', placeholder: 'Run linter, fix issues, verify fix' },
        { key: 'repo_path', type: 'text', id: 'wf-input-repo', label: 'Repository path', placeholder: '/path/to/project' },
        limitField(),
    ];
}

// -- Save -------------------------------------------------------------------------------------------------

async function submitWorkflow(values) {
    const steps = values.steps.map(r => {
        // What the step had, with what the editor shows written over it (a step whose type changed drops the other type's text).
        const step = { ...(loadedSteps.get(r.item) || {}), name: r.name, type: r.type };
        if (r.type === 'shell') { step.command = r.content; delete step.prompt; }
        else { step.prompt = r.content; delete step.command; }
        return step;
    });
    const name = String(values.name || '').trim();
    const repo = String(values.repo_path || '').trim();
    const body = { name, description: String(values.description || '').trim(), steps, max_duration_s: values.max_duration_s.seconds };
    if (repo) body.repo_path = repo;
    try {
        await apiFetch(editingWorkflowId ? `/api/workflows/${editingWorkflowId}` : '/api/workflows', {
            method: editingWorkflowId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        let msg = e.message;
        try { const j = JSON.parse(msg.replace(/^\d+:\s*/, '')); msg = j.error || msg; } catch (_) { /* not JSON: the message as it is */ }
        throw new Error(msg);
    }
    showToast(`${editingWorkflowId ? 'Updated' : 'Created'} workflow "${name}"`);
    hideWorkflowCreateModal();
    hooks.saved(editingWorkflowId); // the list is read again, and an edited workflow's page too
}

// -- the dialog -------------------------------------------------------------------------------------------

function workflowView() {
    if (view) return view;
    const footer = document.getElementById('wf-footer');
    footer.replaceChildren();
    view = mountSettingsView(document.getElementById('wf-form'), {
        mode: 'form',
        fields: workflowFields(),
        form: { submit: 'Create workflow', submitId: 'wf-modal-save', cancel: 'Cancel', barHost: footer, onSubmit: submitWorkflow, onCancel: hideWorkflowCreateModal },
    });
    return view;
}

function openModal(title, submit) {
    document.getElementById('wf-modal-title').textContent = title;
    document.getElementById('wf-modal-save').textContent = submit;
    document.getElementById('wf-create-modal').style.display = 'flex'; // display-ok: a dialog is shown as the flex container the .modal rule centres (modal_chrome and the close census read it)
}

/** Fill the form from a template (the name only when the person has not typed one); the blank choice puts the example step back. */
function applyTemplate(id) {
    const v = workflowView(), t = templateById(id);
    if (!t) { v.set('steps', [EXAMPLE_STEP]); document.querySelector('#wf-steps-editor .wf-step-content').placeholder = EXAMPLE_COMMAND; return; }
    v.set('name', t.name); v.set('description', t.description); v.set('steps', t.steps.map(s => ({ ...s })));
    v.fold(true); // the description it filled is shown
}

/** The template row is for a new workflow: not for Edit, and not for a duplicate (it already is a copy of one). */
function showTemplateRow(on) {
    const row = document.getElementById('wf-input-template')?.closest('.sv-row');
    if (row) row.hidden = !on;
}

export function showWorkflowCreateModal(onClose) {
    const v = workflowView();
    editingWorkflowId = null;
    returnTo = typeof onClose === 'function' ? onClose : null;
    v.reset(); // every field at its default, no errors, an empty status line
    v.set('steps', [EXAMPLE_STEP]); // the example step, to fill in
    document.querySelector('#wf-steps-editor .wf-step-content').placeholder = EXAMPLE_COMMAND;
    document.getElementById('wf-build-hint').hidden = false;
    showTemplateRow(true); v.set('template', TEMPLATE_NONE);
    v.fold(false);
    openModal('New workflow', 'Create workflow');
    document.getElementById('wf-input-name').focus();
}

export async function editWorkflow(id) {
    const wf = await hooks.fetchDetail(id);
    if (!wf) return;
    const v = workflowView();
    editingWorkflowId = id; returnTo = null;
    document.getElementById('wf-build-hint').hidden = true; // a workflow that exists is changed with Edit with Agent on its page
    showTemplateRow(false);
    v.reset();
    for (const [k, val] of Object.entries({ name: wf.name || '', steps: wf.steps || [], description: wf.description || '', repo_path: wf.repo_path || '', max_duration_s: wf.max_duration_s || DEFAULT_LIMIT_S })) v.set(k, val);
    // Nothing a workflow already has is hidden: More options opens when it holds something other than the defaults.
    v.fold(!!(wf.description || wf.repo_path || (wf.max_duration_s && wf.max_duration_s !== DEFAULT_LIMIT_S)));
    openModal('Edit workflow', 'Save changes');
}

/** Duplicate (#10277): the New workflow dialog filled from a workflow that exists, with a name of its own to choose (its name and "-copy"); nothing is saved until Create workflow. */
export async function duplicateWorkflow(id) {
    const wf = await hooks.fetchDetail(id);
    if (!wf) return;
    const v = workflowView();
    editingWorkflowId = null; returnTo = null;
    document.getElementById('wf-build-hint').hidden = true;
    showTemplateRow(false);
    v.reset();
    for (const [k, val] of Object.entries({ name: `${wf.name || 'workflow'}-copy`, steps: (wf.steps || []).map(s => ({ ...s })), description: wf.description || '', repo_path: wf.repo_path || '', max_duration_s: wf.max_duration_s || DEFAULT_LIMIT_S })) v.set(k, val);
    v.fold(!!(wf.description || wf.repo_path || (wf.max_duration_s && wf.max_duration_s !== DEFAULT_LIMIT_S)));
    openModal('New workflow', 'Create workflow');
    document.getElementById('wf-input-name').focus();
}

export function hideWorkflowCreateModal(skipReturn) {
    document.getElementById('wf-create-modal').style.display = 'none'; // display-ok: the same inline state the dialog was opened with
    const back = returnTo; returnTo = null;
    if (back && skipReturn !== true) back();
}

/** Save from the caller (the same check and send as the button). */
export function saveWorkflow() { return workflowView().submit(); }

registerActions({
    'wf-edit': el => withId(el.dataset.workflowId, editWorkflow),
    'wf-duplicate': el => withId(el.dataset.workflowId, duplicateWorkflow),
});
