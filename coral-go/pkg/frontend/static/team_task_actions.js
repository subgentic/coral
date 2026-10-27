/* A task's actions on its page (#7644): Edit, Complete, Cancel, Publish, Nudge, Remind and its dependencies, which were the task dialog's. The page's pinned bar holds the buttons; Edit and Complete turn the page into their form (the
 * bar then holds Cancel and Save, or Back and Complete), Cancel asks in the bar ("Cancel this task? This cannot be undone."). The calls are the dialog's: the board's task routes as the Operator, the same words in the same errors.
 * Everything drawn is built with the DOM and textContent: titles, bodies, names and the required outputs are written by agents. Lazy: team_tasks_page.js imports it.
 *
 *   taskButtons(task, ctx)               the bar's buttons for this task's state
 *   editForm(task, ctx)  -> Promise<{ node, save() }>      completeForm(task, ctx) -> { node, submit() }
 *   ctx: { project, redraw(task, mode), reload(message), back() } */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { boardFetch, pathId } from './server_base.js';
import { showToast } from './utils.js';
const { el } = await importOnce('./team_table.js'); // lazy: its failure is retried
const { readOpenGoals, readGoal, fillGoalSelect, showGoalInvalid, chooseGoalLabel } = await importOnce('./task_goals.js');
const { _renderDepPicker, _getSelectedDeps } = await importOnce('./task_dep_picker.js');
const { _taskRequiredOutputs, nudgeBoardTask, remindBoardTask, stopBoardTaskReminder } = await importOnce('./task_reminders.js');
const { loadBoardTasks } = await importOnce('./task_list.js');
const { reviewRequested } = await importOnce('./task_list_data.js');

const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

/** A task that can still be changed: not waiting on a review, and open. */
export const isOpen = (t) => !reviewRequested(t) && ['pending', 'in_progress', 'blocked', 'draft'].includes(t.status);

async function failure(resp) { const data = await resp.json().catch(() => ({})); return new Error(data.error || `HTTP ${resp.status}`); }

// ── the bar ──────────────────────────────────────────────────────────────

export function taskButtons(task, ctx) {
    if (!isOpen(task)) return ['completed', 'skipped'].includes(task.status) ? [] : [btn('btn', 'Edit', () => ctx.redraw(task, 'edit'))];
    const out = [];
    const canComplete = task.status !== 'blocked' && task.status !== 'draft';
    const canNudge = (task.status === 'pending' || task.status === 'in_progress') && !!task.assigned_to;
    // The bar has two buttons, the primary last (#9076, the Operator: fewer buttons): everything else is under More, Cancel last. The agent is the Assigned-to link on the page (team_tasks_page.js factsOf).
    const items = [{ label: 'Edit', run: () => ctx.redraw(task, 'edit') }];
    if (canNudge) items.push(
        { label: 'Nudge', title: `Remind ${task.assigned_to} about this task in their terminal`, run: () => nudgeBoardTask(task.id) },
        { label: 'Remind', title: `Send periodic reminders to ${task.assigned_to}`, run: () => remindBoardTask(task.id) },
        { label: 'Stop reminders', title: 'Stop periodic reminders', run: () => stopBoardTaskReminder(task.id) });
    items.push({ label: 'Cancel task', danger: true, className: 'team-task-cancel', run: () => ctx.redraw(task, 'cancel') });
    out.push(moreMenu(`task-more-${task.id}`, items));
    if (task.status === 'draft') out.push(btn('btn btn-primary', 'Publish', () => publish(task, ctx)));
    if (canComplete) out.push(btn('btn btn-primary', 'Complete', () => ctx.redraw(task, 'complete')));
    return out;
}

/** A text More button and its menu (menu_button.js: arrow keys, Escape, the menu opens upward where the bar leaves no room below). items: [{ label, title, danger, className, run }]. */
function moreMenu(id, items) {
    const wrap = el('span', 'task-more');
    const toggle = btn('btn task-more-btn', 'More'); toggle.id = id; toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${id}-menu`);
    const menu = el('div', 'team-more-menu task-more-menu'); menu.id = `${id}-menu`; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'More task actions');
    for (const it of items) {
        const b = btn(it.danger ? 'mb-action-danger' : '', it.label, async () => { (await importOnce('./menu_button.js')).closeMenus(); it.run(); });
        b.setAttribute('role', 'menuitem'); if (it.title) b.title = it.title; if (it.className) b.classList.add(it.className);
        menu.append(b);
    }
    toggle.addEventListener('click', async () => (await importOnce('./menu_button.js')).toggleMenu(toggle));
    wrap.append(toggle, menu);
    return wrap;
}

/** The bar while Cancel asks: the question and its two answers. */
export function cancelConfirm(task, ctx) {
    const box = el('div', 'task-confirm-inline');
    box.append(el('span', 'task-confirm-text', 'Cancel this task? This cannot be undone.'));
    const buttons = el('div', 'task-confirm-buttons');
    const yes = btn('btn btn-danger', 'Cancel task', async () => {
        try {
            const resp = await boardFetch(ctx.project, `/tasks/${pathId(task.id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator' }) });
            if (!resp.ok) throw await failure(resp);
            ctx.reload('Task cancelled');
        } catch (e) { showToast(e.message || 'Failed to cancel task', true); }
    });
    const keep = btn('btn', 'Keep task', () => ctx.redraw(task, 'view'));
    buttons.append(keep, yes);
    box.append(buttons);
    queueMicrotask(() => keep.focus()); // the safe answer is the default (UI/UX)
    return box;
}

async function publish(task, ctx) {
    try {
        const resp = await boardFetch(ctx.project, `/tasks/${pathId(task.id)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator' }) }); // publishing is a planner's step (#3668)
        if (!resp.ok) throw await failure(resp);
        ctx.reload('Task published');
    } catch (e) { showToast(e.message || 'Failed to publish task', true); }
}

// ── Edit ─────────────────────────────────────────────────────────────────

const labelled = (text, control, id) => { const l = el('label', null, text); l.htmlFor = id; l.append(control); return l; };
const input = (id, value = '') => { const i = el('input'); i.type = 'text'; i.id = id; i.value = value; return i; };
const area = (id, value, rows = 3) => { const t = el('textarea'); t.id = id; t.rows = rows; t.value = value; return t; };
const option = (value, text, selected) => { const o = el('option', null, text); o.value = value; if (selected) o.selected = true; return o; };

/** The edit form for a task: title, description, instructions and why they change, priority, assignee, goal, and the tasks it waits for. save() writes what changed. */
export async function editForm(task, ctx) {
    if (reviewRequested(task)) return textEditForm(task, ctx);
 const project = ctx.project;
    // Subscriber presence is not assignment authority: an inactive or unavailable assignee stays selected even if discovery fails.
    const assignee = el('select'); assignee.id = 'task-edit-assignee';
    assignee.append(option('', 'Unassigned', !task.assigned_to));
    const names = new Set();
    if (task.assigned_to) { names.add(task.assigned_to); assignee.append(option(task.assigned_to, task.assigned_to, true)); }
    try {
        const resp = await boardFetch(project, '/subscribers');
        if (resp.ok) for (const s of await resp.json().then(v => (Array.isArray(v) ? v : []))) { const name = s && (s.subscriber_id || s.name); if (typeof name === 'string' && name && !names.has(name)) { names.add(name); assignee.append(option(name, name, false)); } }
    } catch { /* the assignee stays */ }
    const goalRead = await readOpenGoals(project);
    const currentGoal = task.goal_id && !goalRead.goals.some(g => g.id === task.goal_id) ? await readGoal(project, task.goal_id) : null; // a closed goal the task has stays in the choice (#7253)
    if (!state.currentBoardTasks || !state.currentBoardTasks.length) await loadBoardTasks(project).catch(() => {}); // the dependency picker offers the board's tasks

    const revision = Number(task.revision || 1);
    const instructions = (task.workflow && (task.workflow.effective_instructions || task.workflow.instructions)) || '';
    const form = el('form', 'team-task-form'); form.noValidate = true; form.addEventListener('submit', e => e.preventDefault());
    const error = el('div', 'modal-error'); error.id = 'task-edit-error'; error.hidden = true; error.setAttribute('role', 'alert');
    const rev = el('div', 'task-edit-revision'); rev.append('Editing revision ', Object.assign(el('strong'), { textContent: String(revision) }), '. Changes to description or instructions require a reason.');
    const priority = el('select'); priority.id = 'task-edit-priority';
    for (const p of ['critical', 'high', 'medium', 'low']) priority.append(option(p, p, p === task.priority));
    const goal = el('select'); goal.id = 'task-edit-goal';
    const goalLabel = labelled('Goal', goal, 'task-edit-goal'); goalLabel.id = 'task-edit-goal-row';
    if (!(goalRead.goals.length || goalRead.requireGoal || task.goal_id)) goalLabel.hidden = true;
    const goalError = el('p', 'task-goal-error modal-error'); goalError.id = 'task-edit-goal-error'; goalError.hidden = true; goalError.setAttribute('role', 'alert');
    form.append(error, rev,
        labelled('Title', input('task-edit-title', task.title), 'task-edit-title'),
        labelled('Description', area('task-edit-body', task.body || ''), 'task-edit-body'),
        labelled('Workflow instructions', area('task-edit-instructions', instructions), 'task-edit-instructions'),
        labelled('Amendment reason', Object.assign(input('task-edit-reason'), { placeholder: 'Why should this instruction change?' }), 'task-edit-reason'),
        labelled('Priority', priority, 'task-edit-priority'),
        labelled('Assigned To', assignee, 'task-edit-assignee'),
        goalLabel, goalError);
    fillGoalSelect(goal, { goals: goalRead.goals, requireGoal: goalRead.requireGoal, selectedId: task.goal_id, current: currentGoal });
    const showDeps = task.status === 'blocked' || task.status === 'pending' || task.status === 'draft';
    if (showDeps) {
        const label = el('p', 'team-task-form-label', 'Blocked by '); label.append(el('span', 'text-muted-sm', '(optional)'));
        const picker = el('div', 'dep-picker'); picker.id = 'task-edit-deps';
        form.append(label, picker);
    }
    const mount = (host) => { if (showDeps) _renderDepPicker('task-edit-deps', (task.blocked_by || []).map(d => d.task_id), task.id); return host; };

    const say = (text) => { error.textContent = text; error.hidden = !text; };
    async function save() {
        const value = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
        const title = value('task-edit-title').trim();
        if (!title) { say('Title is required'); return; }
        const body = value('task-edit-body').trim(), prio = value('task-edit-priority'), assigned = value('task-edit-assignee');
        const updates = {}, amendments = {}; // the edit route needs its actor for a title or priority too (the dialog sent it only with an assignee: a title edit was refused)
        if (title !== task.title) updates.title = title;
        const newInstructions = value('task-edit-instructions').trim();
        if (body !== (task.body || '')) amendments.body = body;
        if (newInstructions !== instructions) amendments.workflow_instructions = newInstructions;
        if (prio !== task.priority) updates.priority = prio;
        if (assigned !== (task.assigned_to || '')) { updates.assigned_to = assigned; updates.subscriber_id = 'Operator'; }
        if (showDeps) {
            const now = _getSelectedDeps('task-edit-deps'), before = (task.blocked_by || []).map(d => d.task_id).sort();
            if (JSON.stringify(before) !== JSON.stringify([...now].sort())) updates.blocked_by = now.map(id => (task.blocked_by || []).find(d => d.task_id === id) || { task_id: id, condition: 'success' });
        }
        const goalValue = document.getElementById('task-edit-goal') ? document.getElementById('task-edit-goal').value : String(task.goal_id || '');
        const goalChanged = goalValue !== String(task.goal_id || '');
        if (!Object.keys(updates).length && !Object.keys(amendments).length && !goalChanged) { ctx.redraw(task, 'view'); return; }
        try {
            if (goalChanged && !goalValue && goalRead.requireGoal) { showGoalInvalid(goal, goalError, `${chooseGoalLabel}: this board needs a goal on every task.`); return; }
            let textVersion = task.version;
            if (Object.keys(amendments).length) {
                const reason = value('task-edit-reason').trim();
                if (!reason) throw new Error('An amendment reason is required for description or instruction changes');
                const r = await boardFetch(project, `/tasks/${pathId(task.id)}/amend`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', base_revision: revision, reason, changes: amendments }) });
                if (!r.ok) throw await failure(r);
                const amended = await r.json(); textVersion = amended.version || textVersion;
            }
            if (Object.keys(updates).length) {
                const r = await boardFetch(project, `/tasks/${pathId(task.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', base_version: textVersion, ...updates }) });
                if (!r.ok) throw await failure(r);
            }
            if (goalChanged) {
                const r = await boardFetch(project, `/tasks/${pathId(task.id)}/goal`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: goalValue ? Number(goalValue) : null, subscriber_id: 'Operator' }) });
                if (!r.ok) throw await failure(r);
            }
            ctx.reload('Task updated');
        } catch (e) { say(e.message || 'Failed to save'); }
    }
    return { node: form, mount, save };
}

// ── Complete ─────────────────────────────────────────────────────────────

/** The completion form: a message, the outcome, the required outputs the task names and the evidence to attach. submit() sends it. */
export function completeForm(task, ctx) {
    const required = _taskRequiredOutputs(task);
    const section = el('section', 'task-completion-form'); section.setAttribute('aria-label', 'Complete task');
    const revision = el('p', 'task-completion-revision'); revision.append('Submitting the task as revision ', Object.assign(el('strong'), { textContent: String(Number(task.revision || 1)) }), '.');
    const box = el('div', 'task-confirm-inline');
    const message = el('textarea'); message.id = 'task-complete-message'; message.rows = 3; message.placeholder = 'What was completed and how was it verified?';
    const outcome = el('select'); outcome.id = 'task-complete-outcome'; outcome.append(option('success', 'Success', true), option('failed', 'Failed', false));
    box.append(labelled('Completion message', message, 'task-complete-message'), labelled('Outcome', outcome, 'task-complete-outcome'));
    if (required.length) {
        const req = el('section', 'task-completion-required'); req.setAttribute('aria-label', 'Required outputs');
        const ul = el('ul'); for (const o of required) ul.append(el('li', null, o));
        req.append(el('strong', null, 'Required outputs'), ul, el('p', null, 'Provide each named output below or in the manifest before completing.'));
        box.append(req);
    } else box.append(el('p', 'task-completion-hint', 'Add a concise outcome and message. Evidence is optional unless the task specifies required outputs.'));
    const details = el('details', 'task-completion-evidence'); if (required.length) details.open = true;
    details.append(el('summary', null, required.length ? 'Evidence and artifacts (required)' : 'Add evidence or artifact metadata (optional)'));
    const name = Object.assign(input('task-artifact-name'), { placeholder: 'build or test_report' });
    const nameLabel = labelled('Artifact name ', name, 'task-artifact-name'); if (required.length) nameLabel.insertBefore(el('span', 'text-muted-sm', '(match a required output)'), name);
    const content = area('task-artifact-content', '', 3); content.placeholder = 'Report or evidence (optional if a reference is provided)';
    const file = el('input'); file.type = 'file'; file.id = 'task-artifacts-file'; file.accept = 'application/json,.json';
    details.append(nameLabel,
        labelled('Artifact URL or reference', Object.assign(input('task-artifact-uri'), { placeholder: 'Durable URL or artifact reference' }), 'task-artifact-uri'),
        labelled('Revision', Object.assign(input('task-artifact-revision'), { placeholder: 'Commit or build version' }), 'task-artifact-revision'),
        labelled('Artifact content', content, 'task-artifact-content'),
        labelled('Attach an artifact manifest', file, 'task-artifacts-file'));
    const error = el('div', 'modal-error'); error.id = 'task-complete-error'; error.hidden = true; error.setAttribute('role', 'alert');
    const refresh = btn('btn task-completion-refresh', 'Refresh task before retrying', () => ctx.reload()); refresh.id = 'task-complete-refresh'; refresh.hidden = true;
    box.append(details, error, refresh);
    section.append(revision, box);

    async function submit() {
        try {
            let artifacts = [];
            const manifest = file.files[0];
            if (manifest) {
                if (manifest.size > 3 * 1024 * 1024) throw new Error('Artifact manifest is too large');
                artifacts = JSON.parse(await manifest.text());
                if (!Array.isArray(artifacts)) throw new Error('Artifact manifest must contain an array');
            }
            const artifactName = name.value.trim();
            if (artifactName) artifacts.push({ name: artifactName, uri: document.getElementById('task-artifact-uri').value.trim(), revision: document.getElementById('task-artifact-revision').value.trim(), content: content.value });
            const supplied = new Set(artifacts.map(a => a && a.name).filter(Boolean));
            const missing = required.filter(o => !supplied.has(o));
            if (missing.length) throw new Error(`Required outputs missing: ${missing.join(', ')}`);
            const resp = await boardFetch(ctx.project, `/tasks/${pathId(task.id)}/complete`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscriber_id: 'Operator', message: message.value.trim() || undefined, outcome: outcome.value || 'success', artifacts, expected_revision: Number(task.revision || 1) }),
            });
            if (!resp.ok) { const e = await failure(resp); e.status = resp.status; throw e; }
            ctx.reload('Task completed');
        } catch (e) {
            error.textContent = e.message || 'Failed to complete task'; error.hidden = false;
            if (e.status === 409) refresh.hidden = false;
            showToast(e.message || 'Failed to complete task', true);
        }
    }
    return { node: section, focus: () => message.focus(), submit };
}

/** Reviews keep their lifecycle; only task text changes in this form. */
function textEditForm(task, ctx) {
 const form = el('form', 'team-task-form'); form.addEventListener('submit', e => e.preventDefault());
 const title = input('task-edit-title', task.title), priority = el('select'); priority.id='task-edit-priority';
 for (const p of ['critical','high','medium','low']) priority.append(option(p,p,p===task.priority));
 const error=el('p');error.setAttribute('role','alert');
 form.append(labelled('Title',title,title.id),labelled('Priority',priority,priority.id),error);
 return {node:form,mount:()=>title.focus(),save:async()=>{try {
 const r=await boardFetch(ctx.project,`/tasks/${pathId(task.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Operator',title:title.value,priority:priority.value,base_version:task.version})});
 if(!r.ok) throw await failure(r);ctx.reload('Task updated');
 }catch(e){error.textContent=e.message;}}};
}
