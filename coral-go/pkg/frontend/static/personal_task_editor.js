/* Personal task prose (#20844): capture the agent and computer before opening. */
import { importOnce } from './import_once.js';
import { serverFetch } from './server_base.js';
import { el } from './dom_el.js';
import { showToast } from './utils.js';
const { mountFieldPictures, savedWords } = await importOnce('./field_pictures.js');
export function openPersonalTaskEditor({ task, session, server, onSaved }) {
    const dlg = el('dialog', 'modal-content dlg-form reminder-dialog');
    dlg.setAttribute('aria-labelledby', 'personal-task-edit-title');
    const h = el('h3', null, 'Edit task'); h.id = 'personal-task-edit-title';
    const form = el('form', 'modal-body reminder-form');
    const title = el('input'); title.value = task.title || ''; title.required = true; title.maxLength = 500; title.setAttribute('aria-label', 'Title');
    const body = el('textarea'); body.rows = 6; body.value = task.body || ''; body.setAttribute('aria-label', 'Description');
    const error = el('p', 'field-error'); error.setAttribute('role', 'alert');
    title.id = 'personal-task-edit-name'; body.id = 'personal-task-edit-body';
    const titleLabel = el('label', null, 'Title'); titleLabel.htmlFor = title.id; titleLabel.append(title);
    const bodyLabel = el('label', null, 'Description'); bodyLabel.htmlFor = body.id; bodyLabel.append(body);
    form.append(titleLabel, bodyLabel, error);
    const pictures = mountFieldPictures(body, { server, scope: 'instruction', field: 'body', initial: task.images?.body || [], hintWhenAdded: true });
    const actions = el('div', 'modal-actions modal-footer'), cancel = el('button', 'btn', 'Cancel'), save = el('button', 'btn btn-primary', 'Save');
    cancel.type = 'button'; cancel.addEventListener('click', () => dlg.close()); save.type = 'submit'; actions.append(cancel, save); form.append(actions); const head = el('div', 'modal-header'); head.append(h); dlg.append(head, form); document.body.append(dlg);
    dlg.addEventListener('close', () => { pictures.destroy(); dlg.remove(); });
    dlg.addEventListener('cancel', e => { if (save.disabled) e.preventDefault(); });
    form.addEventListener('submit', async e => {
        e.preventDefault(); error.textContent = '';
        try {
            const payload = { ...pictures.payload() };
            if (title.value.trim() !== task.title) payload.title = title.value.trim();
            if (body.value.trim() !== (task.body || '')) payload.body = body.value.trim();
            if (Object.keys(payload).length === 0) { dlg.close(); return; }
            save.disabled = cancel.disabled = true;
            const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(session.name)}/tasks/${Number(task.id)}?session_id=${encodeURIComponent(session.session_id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const kept = await resp.json();
            if (!resp.ok) throw new Error(kept.error || 'Could not save the task.');
            dlg.close(); showToast(savedWords(kept, 'Task saved'), !!kept.pictures_not_saved); await onSaved?.();
        } catch (ex) { error.textContent = ex.message; save.disabled = cancel.disabled = false; }
    });
    dlg.showModal(); title.focus(); return dlg;
}
