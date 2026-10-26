/* Workflows: the create and edit form: its steps, its time limit and Save (moved out of workflows.js, #8360; no behaviour change). */

import { escapeHtml as esc, escapeAttr as escAttr, showToast } from './utils.js';
import { registerActions, withId } from './actions.js';
import { apiFetch } from './api.js';
import { limitSeconds, limitParts } from './time_limit.js';

let editingWorkflowId = null; // non-null when editing
let hooks = { fetchDetail: async () => null, saved: () => {} };

/** workflows.js tells the form how to read a workflow and what to redraw when one is saved (the form imports nothing back from the page). */
export function initWorkflowEditor(h) { hooks = { ...hooks, ...h }; }

// ── Create / Edit modal ────────────────────────────────────────────────

export function showWorkflowCreateModal() {
    editingWorkflowId = null;
    document.getElementById('wf-modal-title').textContent = 'New workflow';
    document.getElementById('wf-modal-save').textContent = 'Create workflow';
    document.getElementById('wf-input-name').value = '';
    document.getElementById('wf-input-desc').value = '';
    document.getElementById('wf-input-repo').value = '';
    showLimit(3600);
    document.getElementById('wf-more').open = false;
    clearMarks();
    document.getElementById('wf-modal-error').style.display = 'none';
    document.getElementById('wf-steps-editor').innerHTML = '';
    // Add one default step
    workflowAddStep();
    document.getElementById('wf-create-modal').style.display = 'flex';
}

export function hideWorkflowCreateModal() {
    document.getElementById('wf-create-modal').style.display = 'none';
}

export async function editWorkflow(id) {
    const wf = await hooks.fetchDetail(id);
    if (!wf) return;

    editingWorkflowId = id;
    document.getElementById('wf-modal-title').textContent = 'Edit workflow';
    document.getElementById('wf-modal-save').textContent = 'Save changes';
    document.getElementById('wf-input-name').value = wf.name || '';
    document.getElementById('wf-input-desc').value = wf.description || '';
    document.getElementById('wf-input-repo').value = wf.repo_path || '';
    showLimit(wf.max_duration_s || 3600);
    // Nothing a workflow already has is hidden: More options opens when it holds something other than the defaults.
    document.getElementById('wf-more').open = !!(wf.description || wf.repo_path || (wf.max_duration_s && wf.max_duration_s !== 3600));
    clearMarks();
    document.getElementById('wf-modal-error').style.display = 'none';

    const editor = document.getElementById('wf-steps-editor');
    editor.innerHTML = '';
    const steps = wf.steps || [];
    steps.forEach(s => workflowAddStep(s));

    document.getElementById('wf-create-modal').style.display = 'flex';
}

const MAX_LIMIT_S = 86400; // the server's ceiling for a workflow's time limit (24 hours)

/** The limit in seconds as the number and unit the form shows ("1 hour", "90 minutes"). */
function showLimit(seconds) {
    const { n, unit } = limitParts(seconds);
    document.getElementById('wf-input-max-dur').value = String(n);
    document.getElementById('wf-input-max-dur-unit').value = String(unit);
    sayLimit('');
}

const limitFromFields = () => limitSeconds(document.getElementById('wf-input-max-dur').value, document.getElementById('wf-input-max-dur-unit').value, MAX_LIMIT_S);

function sayLimit(text) {
    const m = document.getElementById('wf-limit-msg');
    m.textContent = text;
    m.hidden = !text;
    const f = document.getElementById('wf-input-max-dur');
    if (text) f.setAttribute('aria-invalid', 'true'); else f.removeAttribute('aria-invalid');
}

/** Show or clear the time limit's sentence as the person types; true when it is fine. */
export function checkWorkflowLimit() {
    const r = limitFromFields();
    sayLimit(r.error || '');
    return !r.error;
}

/** A fresh form shows no mark from the last time. */
function clearMarks() {
    for (const f of document.querySelectorAll('#wf-create-modal [aria-invalid]')) {
        f.removeAttribute('aria-invalid');
        const rest = (f.getAttribute('aria-describedby') || '').split(' ').filter(t => t && t !== 'wf-modal-error').join(' '); // the error line goes, a field's own help stays
        if (rest) f.setAttribute('aria-describedby', rest); else f.removeAttribute('aria-describedby');
    }
}

// The step each editor row was loaded from: the editor shows only a step's name, type and command or prompt, and Save keeps
// every other field (timeout_s, agent, continue_on_failure, hooks, interactive, output_artifact, and any it doesn't know).
const loadedSteps = new WeakMap();

export function workflowAddStep(step) {
    const editor = document.getElementById('wf-steps-editor');
    const type = step ? step.type || 'shell' : 'shell';
    const name = step ? step.name || '' : '';
    const content = step ? (type === 'shell' ? step.command || '' : step.prompt || '') : '';

    const div = document.createElement('div');
    div.className = 'wf-step-editor-item';
    div.innerHTML = `
        <div class="wf-step-editor-top">
            <span class="wf-step-num" aria-hidden="true"></span>
            <select class="wf-step-type-select" data-on-change="wf-step-type">
                <option value="shell" ${type === 'shell' ? 'selected' : ''}>shell</option>
                <option value="agent" ${type === 'agent' ? 'selected' : ''}>agent</option>
            </select>
            <input type="text" class="wf-step-name-input" placeholder="Step name" value="${escAttr(name)}">
            <button type="button" class="wf-step-remove-btn" data-on-click="wf-step-remove" title="Remove step">&times;</button>
        </div>
        <div class="wf-step-editor-body">
            <textarea class="wf-step-content" placeholder="${type === 'shell' ? 'Shell command...' : 'Agent prompt...'}" rows="2">${esc(content)}</textarea>
        </div>
    `;
    if (step) loadedSteps.set(div, step);
    editor.appendChild(div);
    nameStepControls();
}

// Each step's controls carry its number, so "Remove step 2" and "Step 2 command" tell the rows apart; renumbered when one is removed.
function nameStepControls() {
    document.querySelectorAll('#wf-steps-editor .wf-step-editor-item').forEach((item, i) => {
        const n = i + 1;
        const num = item.querySelector('.wf-step-num'); if (num) num.textContent = `Step ${n}`;
        item.querySelector('.wf-step-type-select')?.setAttribute('aria-label', `Step ${n} type`);
        item.querySelector('.wf-step-name-input')?.setAttribute('aria-label', `Step ${n} name`);
        item.querySelector('.wf-step-remove-btn')?.setAttribute('aria-label', `Remove step ${n}`);
        item.querySelector('.wf-step-content')?.setAttribute('aria-label', `Step ${n} ${item.querySelector('.wf-step-type-select')?.value === 'agent' ? 'prompt' : 'command'}`);
    });
}

export function workflowStepTypeChanged(select) {
    const textarea = select.closest('.wf-step-editor-item').querySelector('.wf-step-content');
    textarea.placeholder = select.value === 'shell' ? 'Shell command...' : 'Agent prompt...';
    nameStepControls();
}

export async function saveWorkflow() {
    const name = document.getElementById('wf-input-name').value.trim();
    const desc = document.getElementById('wf-input-desc').value.trim();
    const repo = document.getElementById('wf-input-repo').value.trim();
    const errEl = document.getElementById('wf-modal-error');

    // Collect steps
    const stepItems = document.querySelectorAll('#wf-steps-editor .wf-step-editor-item');
    const steps = [];
    let at = 0;
    for (const item of stepItems) {
        at++;
        const type = item.querySelector('.wf-step-type-select').value;
        const stepName = item.querySelector('.wf-step-name-input').value.trim();
        const content = item.querySelector('.wf-step-content').value.trim();
        if (!stepName) { showError(errEl, `Step ${at} needs a name.`, item.querySelector('.wf-step-name-input')); return; }
        if (!content) { showError(errEl, `Step ${at} (${stepName}) needs a ${type === 'shell' ? 'command' : 'prompt'}.`, item.querySelector('.wf-step-content')); return; }

        // What the step had, with what the editor shows written over it (a step whose type changed drops the other type's text).
        const step = { ...(loadedSteps.get(item) || {}), name: stepName, type };
        if (type === 'shell') { step.command = content; delete step.prompt; }
        else { step.prompt = content; delete step.command; }
        steps.push(step);
    }

    if (!name) { showError(errEl, 'Give the workflow a name.', document.getElementById('wf-input-name')); return; }
    if (!steps.length) { showError(errEl, 'Add at least one step.'); return; }
    const limit = limitFromFields();
    if (limit.error) { document.getElementById('wf-more').open = true; sayLimit(limit.error); document.getElementById('wf-input-max-dur').focus(); showError(errEl, limit.error); return; }
    const maxDur = limit.seconds;

    const body = { name, description: desc, steps, max_duration_s: maxDur };
    if (repo) body.repo_path = repo;

    try {
        if (editingWorkflowId) {
            await apiFetch(`/api/workflows/${editingWorkflowId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            showToast(`Updated workflow "${name}"`);
        } else {
            await apiFetch('/api/workflows', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            showToast(`Created workflow "${name}"`);
        }
        hideWorkflowCreateModal();
        hooks.saved(editingWorkflowId); // the list is read again, and an edited workflow's page too
    } catch (e) {
        let msg = e.message;
        try { const j = JSON.parse(msg.replace(/^\d+:\s*/, '')); msg = j.error || msg; } catch (_) {}
        showError(errEl, msg);
    }
}

// An editor error is said (the message is an alert), the field it is about is marked and described by it, and focus goes there; typing in the field clears the mark (#6348).
function showError(el, msg, field) {
    el.textContent = msg;
    el.style.display = '';
    if (!field) return;
    const was = field.getAttribute('aria-describedby') || ''; // a field's own help (the Name's allowed characters) stays described
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', [...new Set([...was.split(' ').filter(Boolean), el.id])].join(' '));
    field.addEventListener('input', () => { field.removeAttribute('aria-invalid'); if (was) field.setAttribute('aria-describedby', was); else field.removeAttribute('aria-describedby'); }, { once: true });
    field.focus();
}

registerActions({
    'wf-edit': el => withId(el.dataset.workflowId, editWorkflow),
    'wf-step-type': el => workflowStepTypeChanged(el),
    'wf-step-remove': el => { el.closest('.wf-step-editor-item')?.remove(); nameStepControls(); },
});
