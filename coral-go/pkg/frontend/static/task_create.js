/* Creating a task: the dialog and its submit (moved out of tasks.js, #5082; no behaviour change). */
import { state } from './state.js';
import { readTaskChoices } from './tasks_view.js';
import { closeOnBackdropAndEscape, releaseEscape } from './dialog_close.js';
import { boardFetch, serverFetch, sessionServer } from './server_base.js';
import { ensureBuilt } from './lazy_dom.js';
import { _getBoardProject, _isSoloAgent, agentTaskAssignee } from './task_board_context.js';
import { _renderDepPicker, _getSelectedDeps } from './task_dep_picker.js';
import { showToast } from './utils.js';
import { addPendingMessage } from './live_chat.js';
import { loadBoardTasks, loadAgentTasks } from './task_list.js';
import { readOpenGoals, fillGoalSelect, chooseGoalLabel } from './task_goals.js';
import { mountSettingsView } from './settings_view.js'; // the dialog's fields (a startup module)

let _project = '', _dependencies, _created = null; // explicit page context, independent of the selected agent/team
let _requireGoal = false; // the board asks for a goal on every task: the Goal select has no empty choice to stay on
let _solo = false;        // an agent without a board: the task goes to this agent, and the board's fields are not shown
let _goalShown = false;   // the board has open goals (or asks for one): the Goal select is shown
let view = null;          // the dialog's form (settings_view in form mode), drawn when the dialog is first opened

const PRIORITIES = [{ value: 'critical', label: 'Critical' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }];
const board = () => !_solo;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const names = text => String(text || '').split(',').map(s => s.trim()).filter(Boolean);

function taskFields() {
    return [
        { key: 'title', type: 'text', id: 'create-task-title', label: 'Title', required: true, requiredMessage: 'Title is required', placeholder: 'Task title' },
        { key: 'body', type: 'textarea', id: 'create-task-body', label: 'Description', rows: 3, placeholder: 'Optional description' },
        { key: 'priority', type: 'select', id: 'create-task-priority', label: 'Priority', default: 'medium', options: PRIORITIES },
        // Board tasks only (hidden for an agent that is not on a board)
        { key: 'assigned_to', type: 'select', id: 'create-task-assignee', label: 'Assigned to', default: '', options: [{ value: '', label: 'Unassigned' }], visibleWhen: board },
        { key: 'goal_id', type: 'select', id: 'create-task-goal', label: 'Goal', default: '', options: [], visibleWhen: () => board() && _goalShown, messageAsIs: true,
            validate: v => (board() && _goalShown && _requireGoal && !v ? `${chooseGoalLabel}: this board needs a goal on every task.` : '') },
        { key: 'draft', type: 'toggle', id: 'create-task-draft', label: 'Create as draft', default: false, help: 'Not visible to agents until published.', visibleWhen: board },
        // Agent without a board: the task goes to this agent
        { key: 'send', type: 'toggle', id: 'create-task-send', label: 'Tell the agent to claim it', default: true, help: 'A short prompt to run coral-agent task claim (queued if it is busy).', visibleWhen: () => _solo },
        { key: 'flow', type: 'heading', fold: true, id: 'create-task-flow', label: 'Workflow and prerequisites' },
        { key: 'blocked_by', type: 'custom', id: 'create-task-deps-field', label: 'Blocked by', default: [], visibleWhen: board,
            render: slot => { const d = el('div', 'dep-picker'); d.id = 'create-task-deps'; slot.append(d); return { get: () => _getSelectedDeps('create-task-deps'), set: ids => _renderDepPicker('create-task-deps', (ids || []).map(Number), null, _dependencies) }; } },
        { key: 'condition', type: 'select', id: 'create-task-condition', label: 'Proceed when prerequisites', default: 'success', visibleWhen: board,
            options: [{ value: 'success', label: 'Succeed' }, { value: 'failure', label: 'Fail' }, { value: 'termination', label: 'Finish (any outcome)' }] },
        { key: 'inputs', type: 'text', id: 'create-task-inputs', label: 'Required upstream artifacts', placeholder: 'build, test_report (comma separated)', default: '', visibleWhen: board },
        { key: 'workflow', type: 'text', id: 'create-task-workflow', label: 'Workflow', placeholder: 'Build -> Test -> Release', default: '', visibleWhen: board },
        { key: 'stage', type: 'text', id: 'create-task-stage', label: 'Stage', placeholder: 'Build, Test, or Release', default: '', visibleWhen: board },
        { key: 'outputs', type: 'text', id: 'create-task-outputs', label: 'Required completion artifacts', placeholder: 'build, test_report (comma separated)', default: '', visibleWhen: board },
        { key: 'instructions', type: 'textarea', id: 'create-task-instructions', label: 'Additional workflow instructions', rows: 3, placeholder: 'Project-specific checks and hand-off requirements', default: '', visibleWhen: board },
        { key: 'flow_note', type: 'notice', visibleWhen: board, render: slot => slot.append(el('p', 'sv-help', 'Coral adds default instructions to every task: consume the specified inputs, publish evidence, report failures honestly, and keep completed stages immutable.')) },
    ];
}

function taskView(modal) {
    if (view) return view;
    const footer = modal.querySelector('#create-task-footer');
    footer.replaceChildren();
    view = mountSettingsView(modal.querySelector('#create-task-form'), {
        mode: 'form', fields: taskFields(),
        form: { submit: 'Create', submitId: 'create-task-submit', cancel: 'Cancel', barHost: footer, onSubmit: submitValues, onCancel: hideCreateTaskModal },
    });
    return view;
}

export async function showCreateTaskModal(preset = {}) {
    const modal = ensureBuilt('create-task-modal'); // built on first open (#4500)
    if (!modal) return;
    _project = typeof preset.project === 'string' ? preset.project : '';
    _created = typeof preset.onCreated === 'function' ? preset.onCreated : null;
    _dependencies = _project ? [] : undefined;
    const v = taskView(modal);

    // Solo agent: no board fields; offer to send the task to the agent
    _solo = !_project && _isSoloAgent();
    _goalShown = false; _requireGoal = false;
    v.reset(); // a fresh task: every field at its default, the optional workflow part folded, no mark, an empty status line
    v.fold(false);
    const flow = document.getElementById('create-task-flow');
    if (flow) flow.hidden = _solo;
    const heading = document.getElementById('create-task-heading');
    if (heading) heading.textContent = _solo
        ? `New task for ${state.currentSession.display_name || state.currentSession.name}`
        : 'Create task';
    v.refresh();

    // Populate assignee dropdown from board subscribers
    const assigneeSelect = document.getElementById('create-task-assignee');
    assigneeSelect.replaceChildren(new Option('Unassigned', ''));
    const boardProject = _solo ? null : (_project || _getBoardProject());
    if (boardProject) {
        try {
            const resp = await boardFetch(boardProject, `/subscribers`);
            if (resp.ok) {
                const subs = await resp.json();
                (subs || []).forEach(s => {
                    const name = s.subscriber_id || s.name;
                    if (name) assigneeSelect.append(new Option(name, name));
                });
            }
        } catch { /* ignore */ }
    }
    assigneeSelect.value = preset.assigned_to ?? (_project ? '' : agentTaskAssignee());

    // The Goal select lists the board's open goals; it stays hidden when the board has none (and does not require one), so a board without goals sees no new control (#7253).
    if (boardProject) {
        const read = await readOpenGoals(boardProject);
        _requireGoal = read.requireGoal;
        fillGoalSelect(document.getElementById('create-task-goal'), { goals: read.goals, requireGoal: read.requireGoal, selectedId: preset.goal_id });
        _goalShown = read.goals.length > 0 || read.requireGoal;
    }

    if (_project) {
        try {
            _dependencies = await readTaskChoices(_project);
        } catch { _dependencies = []; }
    }
    // A template or duplicate can supply workflow/prerequisites. Reveal those values.
    if (!_solo) {
        const deps = preset.blocked_by || [];
        v.set('blocked_by', deps.map(d => d.task_id));
        const workflow = preset.workflow || {};
        const values = { workflow: workflow.name, stage: workflow.stage,
            outputs: workflow.required_outputs?.join(', '), instructions: workflow.instructions,
            inputs: deps[0]?.required_artifacts?.join(', ') };
        for (const [field, value] of Object.entries(values)) if (value) v.set(field, value);
        const condition = deps[0]?.condition || preset.condition || 'success';
        v.set('condition', condition);
        v.fold(deps.length > 0 || condition !== 'success' || Object.values(values).some(Boolean));
    }
    v.refresh();

    modal.style.display = '';
    document.getElementById('create-task-title').focus();

    closeOnBackdropAndEscape(modal, hideCreateTaskModal);
}

export function hideCreateTaskModal() {
    const modal = document.getElementById('create-task-modal');
    if (!modal) return;
    modal.style.display = 'none';
    releaseEscape(modal);
}

/** The form's values to the board's or the agent's task list (the dialog's Create). A refusal is thrown and said on the line beside the buttons; one the server names opens the workflow part. */
async function submitValues(values) {
    const title = String(values.title || '').trim();
    const body = String(values.body || '').trim();
    if (_solo) { await _createSoloAgentTask(title, body, values); return; }
    const boardProject = _project || _getBoardProject();
    if (!boardProject) throw new Error('No board project found');
    const goalId = _goalShown ? values.goal_id : '';
    const blockedBy = values.blocked_by || [];
    try {
        const payload = { title, body, priority: values.priority, assigned_to: values.assigned_to, created_by: 'Operator' };
        if (blockedBy.length > 0) payload.blocked_by = blockedBy.map(task_id => ({ task_id, condition: values.condition || 'success', required_artifacts: names(values.inputs) }));
        payload.workflow = { name: String(values.workflow || '').trim(), stage: String(values.stage || '').trim(), required_outputs: names(values.outputs), instructions: String(values.instructions || '').trim() };
        if (values.draft) payload.draft = true;
        if (goalId) payload.goal_id = Number(goalId);
        const resp = await boardFetch(boardProject, `/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        hideCreateTaskModal();
        if (_created) await _created();
        else await loadBoardTasks(boardProject);
        showToast('Task created');
    } catch (e) {
        view.fold(true); // server validation can name a workflow or prerequisite field; keep all of them visible
        throw e;
    }
}

// A task for an agent without a board goes on the agent's task list in Coral
// (title and details). Unless unchecked, the agent gets a short prompt to
// claim it with `coral-agent task claim`, which marks it in progress and
// shows the details; `coral-agent task complete <id>` marks it done.
async function _createSoloAgentTask(title, body, values) {
    const session = state.currentSession;
    const notify = values.send !== false;
    // With notify, the server types the claim prompt into the agent's
    // terminal and returns it (see claimPrompt in routes/agent_tasks.go).
    const resp = await serverFetch(sessionServer(session), `/api/sessions/live/${encodeURIComponent(session.name)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, priority: values.priority || 'medium', session_id: session.session_id, notify }),
    });
    const task = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(task.error || `HTTP ${resp.status}`);
    if (task.notify_error) throw new Error(`The task was added, but telling the agent failed: ${task.notify_error}`);
    if (task.notified) addPendingMessage(session.session_id, task.notified);
    hideCreateTaskModal();
    await loadAgentTasks(session.name, session.session_id);
    showToast(notify ? 'Task added; the agent was told to claim it' : 'Task added');
}
