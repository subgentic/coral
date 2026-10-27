/* Immutable task text versions; all task/user strings are written as text. */
import { boardFetch, pathId } from './server_base.js';
export async function taskVersionHistory(project, task, reload) {
    const root = document.createElement('details'); root.className = 'task-version-history';
    const summary = document.createElement('summary'); summary.textContent = `Versions (v${task.version || 1})`; root.append(summary);
    const body = document.createElement('div'); root.append(body);
    let loaded = false;
    root.addEventListener('toggle', async () => {
        if (!root.open || loaded) return;
        body.textContent = 'Loading versions…';
        try {
            const r = await boardFetch(project, `/tasks/${pathId(task.id)}/history`);
            if (!r.ok) throw new Error('Versions could not be read. Close and reopen to retry.');
            const versions = await r.json(); body.replaceChildren(); loaded = true;
            for (const v of versions.slice().reverse()) {
                const item = document.createElement('details'), label = document.createElement('summary');
                label.textContent = `v${v.version} · ${v.editor} · ${new Date(v.created_at).toLocaleString()}`; item.append(label);
                for (const [field, change] of Object.entries(v.changes || {})) {
                    const line = document.createElement('p'); line.textContent = `${({ title: 'Title', body: 'Description', priority: 'Priority', instructions: 'Instructions' })[field] || field}: ${change.before} → ${change.after}`; item.append(line);
                }
                for (const [field, title] of [['title', 'Title'], ['body', 'Description'], ['priority', 'Priority']]) {
                    const label = document.createElement('strong'); label.textContent = title;
                    const text = document.createElement('p'); text.textContent = v.snapshot?.[field] || '—'; text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; item.append(label, text);
                }
                const instructions = document.createElement('details'), instructionsLabel = document.createElement('summary');
                instructionsLabel.textContent = 'Instructions'; instructions.append(instructionsLabel);
                const instructionsText = document.createElement('p'); instructionsText.textContent = v.snapshot?.instructions || '—'; instructions.append(instructionsText); item.append(instructions);
                if (v.version !== task.version && !['completed', 'skipped'].includes(task.status)) {
                    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'btn'; restore.textContent = `Restore v${v.version} as a new edit`;
                    restore.addEventListener('click', async () => {
                        restore.disabled = true;
                        try {
                            const response = await boardFetch(project, `/tasks/${pathId(task.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', restore_version: v.version, base_version: task.version }) });
                            if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Restore failed'); }
                            reload('Task text restored as a new version');
                        } catch (e) { const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = e.message; item.append(error); restore.disabled = false; }
                    });
                    item.append(restore);
                }
                body.append(item);
            }
        } catch (e) { body.textContent = e.message; }
    });
    const rounds = task.workflow?.review_rounds || [];
    for (const round of rounds) for (const reviewer of round.reviewers || []) {
        for (const approval of reviewer.previous_text_approvals || []) {
            const prior = document.createElement('p'); prior.textContent = `${reviewer.reviewer}: earlier approval of v${approval.version} at ${approval.at}${approval.note ? ': ' + approval.note : ''}`; root.append(prior);
        }
        if (reviewer.task_version && reviewer.task_version < task.version && ['approved', 'stale'].includes(reviewer.state)) {
            const note = document.createElement('p'); note.setAttribute('role', 'status'); note.textContent = `${reviewer.reviewer} approved v${reviewer.task_version}; the task changed to v${task.version} since that review. A new approval is required.`; root.append(note); root.open = true;
        }
    }
    return root;
}
