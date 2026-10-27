/* The task dialog (#5082): now an agent's own task and a subagent's detail only. A board's task is the team page's task page (#7644): its Edit, Complete, Cancel, Publish, Nudge and Remind are team_task_actions.js. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { escapeHtml, showToast } from './utils.js';
import { clearOpenSubagent } from './subagents.js';
const { _taskDetailHtml } = await importOnce('./task_detail_html.js'); // lazy modules load the others they need through importOnce, so a failed load is retried
import { _agentTaskStatus } from './task_format.js';
import { closeOnBackdropAndEscape, releaseEscape } from './dialog_close.js';
import { pathId, serverFetch, currentServer } from './server_base.js';
import { _taskRequiredOutputs } from './task_reminders.js';
import { loadAgentTasks } from './task_list.js';

// Tasks created for an agent that is not on a board. Complete is its only action.
export function showAgentTaskDetailModal(taskId) {
    clearOpenSubagent();
    const sharedContent = document.getElementById('task-detail-content');
    if (sharedContent) { sharedContent._subagentHtml = null; delete sharedContent.dataset.subagentId; }
    const t = (state.currentAgentTasks || []).find(t => t.id === taskId);
    const modal = document.getElementById('task-detail-modal');
    const titleEl = document.getElementById('task-detail-modal-title');
    const content = document.getElementById('task-detail-content');
    if (!t || !modal || !content) return;

    const agentDisplayName = state.currentSession ? (state.currentSession.display_name || state.currentSession.name) : '';
    const task = {
        ...t,
        _source: 'agent',
        status: _agentTaskStatus(t),
        assigned_to: t.display_name || t.agent_name || agentDisplayName || null,
        claimed_at: t.started_at || null,
        // Agent tasks report 0 until usage is attributed; don't show a $0 breakdown.
        cost_usd: t.cost_usd > 0 ? t.cost_usd : null,
    };

    titleEl.textContent = `Task #${task.id}`;
    content.innerHTML = _taskDetailHtml(task, null);
    modal.setAttribute('aria-labelledby', 'task-detail-modal-title task-detail-heading');

    const footer = document.getElementById('task-detail-modal-footer');
    if (footer) {
        const open = task.status === 'pending' || task.status === 'in_progress';
        footer.innerHTML = `
            <span style="flex:1"></span>
            <button class="btn" data-on-click="task-close">Close</button>
            ${open ? `<button class="btn btn-primary" data-on-click="task-complete" data-task-id="${Number(task.id)}" data-personal="1">Complete</button>` : ''}`;
    }

    _openTaskDetailModal(modal);
}


function _openTaskDetailModal(modal) {
    modal.style.display = '';
    // Close on backdrop click and on Escape
    closeOnBackdropAndEscape(modal, hideTaskDetailModal);
}


/** The form that completes an agent's own task, in the dialog: a message, the outcome, the evidence (the board's version is team_task_actions.js). */
export function completeAgentTask(taskId) {
    const footer = document.getElementById('task-detail-modal-footer');
    const content = document.getElementById('task-detail-content');
    if (!footer || !content) return;
    const task = (state.currentAgentTasks || []).find(item => item.id === taskId);
    const requiredOutputs = _taskRequiredOutputs(task);
    const requiredLabel = requiredOutputs.length
        ? `<section class="task-completion-required" aria-label="Required outputs"><strong>Required outputs</strong><ul>${requiredOutputs.map(output => `<li>${escapeHtml(output)}</li>`).join('')}</ul><p>Provide each named output below or in the manifest before completing.</p></section>`
        : '<p class="task-completion-hint">Add a concise outcome and message. Evidence is optional unless the task specifies required outputs.</p>';
    content.insertAdjacentHTML('beforeend', `
        <section class="task-completion-form" aria-label="Complete task">
            <p class="task-completion-revision">Submitting the task as revision <strong>${Number(task?.revision || 1)}</strong>.</p>
            <div class="task-confirm-inline">
                <label for="task-complete-message">Completion message <textarea id="task-complete-message" rows="3" placeholder="What was completed and how was it verified?"></textarea></label>
                <label for="task-complete-outcome">Outcome <select id="task-complete-outcome"><option value="success">Success</option><option value="failed">Failed</option></select></label>
                ${requiredLabel}
                <details class="task-completion-evidence" ${requiredOutputs.length ? 'open' : ''}>
                    <summary>${requiredOutputs.length ? 'Evidence and artifacts (required)' : 'Add evidence or artifact metadata (optional)'}</summary>
                    <label for="task-artifact-name">Artifact name ${requiredOutputs.length ? '<span class="text-muted-sm">(match a required output)</span>' : ''}<input id="task-artifact-name" placeholder="build or test_report"></label>
                    <label for="task-artifact-uri">Artifact URL or reference<input id="task-artifact-uri" placeholder="Durable URL or artifact reference"></label>
                    <label for="task-artifact-revision">Revision<input id="task-artifact-revision" placeholder="Commit or build version"></label>
                    <label for="task-artifact-content">Artifact content<textarea id="task-artifact-content" rows="3" placeholder="Report or evidence (optional if a reference is provided)"></textarea></label>
                    <label for="task-artifacts-file">Attach an artifact manifest<input type="file" id="task-artifacts-file" accept="application/json,.json"></label>
                </details>
                <div id="task-complete-error" class="modal-error" role="alert" hidden></div>
                <button id="task-complete-refresh" class="btn task-completion-refresh" type="button" hidden>Refresh task before retrying</button>
            </div>
        </section>`);
    footer.innerHTML = `
        <button class="btn" data-on-click="task-complete-back" data-task-id="${Number(taskId)}">Back</button>
        <span style="flex:1"></span>
        <button class="btn btn-primary" data-on-click="task-complete-do" data-task-id="${Number(taskId)}">Complete</button>`;
    document.getElementById('task-complete-message').focus();
}

export async function _doCompleteAgentTask(taskId) {
    const sessionId = state.currentSession?.session_id;
    if (!sessionId) return;
    const msgEl = document.getElementById('task-complete-message');
    const message = msgEl ? msgEl.value.trim() : '';
    try {
        let artifacts = [];
        const file = document.getElementById('task-artifacts-file')?.files[0];
        if (file) {
            if (file.size > 3 * 1024 * 1024) throw new Error('Artifact manifest is too large');
            artifacts = JSON.parse(await file.text());
            if (!Array.isArray(artifacts)) throw new Error('Artifact manifest must contain an array');
        }
        const name = document.getElementById('task-artifact-name')?.value.trim();
        if (name) artifacts.push({ name,
            uri: document.getElementById('task-artifact-uri').value.trim(),
            revision: document.getElementById('task-artifact-revision').value.trim(),
            content: document.getElementById('task-artifact-content').value,
        });
        const task = (state.currentAgentTasks || []).find(item => item.id === taskId);
        const requiredOutputs = _taskRequiredOutputs(task);
        const suppliedNames = new Set(artifacts.map(artifact => artifact?.name).filter(Boolean));
        const missingOutputs = requiredOutputs.filter(output => !suppliedNames.has(output));
        if (missingOutputs.length) throw new Error(`Required outputs missing: ${missingOutputs.join(', ')}`);
        const outcome = document.getElementById('task-complete-outcome')?.value || 'success';
        const resp = await serverFetch(currentServer(), `/api/agent/tasks/${pathId(taskId)}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, message: message || undefined, outcome, artifacts }),
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            const error = new Error(data.error || `HTTP ${resp.status}`);
            error.status = resp.status;
            throw error;
        }
        hideTaskDetailModal();
        await loadAgentTasks(state.currentSession.name, sessionId);
        showToast('Task completed');
    } catch (e) {
        const errorEl = document.getElementById('task-complete-error');
        if (errorEl) { errorEl.textContent = e.message || 'Failed to complete task'; errorEl.hidden = false; }
        const refresh = document.getElementById('task-complete-refresh');
        if (refresh && e.status === 409) {
            refresh.hidden = false;
            refresh.onclick = async () => {
                await loadAgentTasks(state.currentSession.name, sessionId);
                showAgentTaskDetailModal(taskId);
            };
        }
        showToast(e.message || 'Failed to complete task', true);
    }
}

export function hideTaskDetailModal() {
    clearOpenSubagent();
    const modal = document.getElementById('task-detail-modal');
    if (!modal) return;
    modal.style.display = 'none';
    releaseEscape(modal);
}
