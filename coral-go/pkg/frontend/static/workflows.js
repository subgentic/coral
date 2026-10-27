/* Workflows: the workflows' list data, a workflow's page, a run's page, and CRUD. The folder (its table, toolbar and way back) is Automations' (automations.js, Goal #74); this module is the pages. */

import { escapeHtml as esc, escapeAttr as escAttr, showView, showToast } from './utils.js';
import { registerActions, withId, textOf } from './actions.js';
import { apiFetch } from './api.js';
import { selectLiveSession } from './sessions.js';
import { pollEvery } from './overload.js';
import { note } from './nav.js';
import { KILL_LOG_NOTE } from './render.js';
import { formatDuration } from './format.js';
import { runFailureHtml, runFailure } from './run_failure.js';
import { resultWords, limitWords, lastWords } from './job_words.js'; // the Jobs pages' words: one set for both
import { foldWayBack } from './sidebar_groups.js';
import { isPhoneLayout } from './phone_layout.js';
import { importOnce } from './import_once.js';
import { whenText } from './when_text.js';

const DT = await importOnce('./data_table.js');
const WE = await importOnce('./workflow_editor.js'); // the create and edit form (#8360): a part of this panel that loads with it
const WR = await importOnce('./workflow_run_html.js'); // the run page's markup (#8360): pure builders that load with this panel
const { formatTime, runDurationHtml, runProgressHtml, runStepHtml, runMetaHtml } = WR;
const WA = await importOnce('./workflow_agent.js'); // Build with Agent and Edit with Agent (#8360): a part of this panel that loads with it
let workflows = [];
let selectedWorkflowId = null;
let currentRunPollTimer = null;
let shownRun = null; // the run renderRunDetail last drew, for the Kill confirmation's wording
const listeners = new Set();
/** The workflows as the last read left them (Automations' folder draws its rows from it), a way to be told when a read changed them, and the one open on screen. */
export const workflowList = () => workflows;
export const onWorkflowsChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const openWorkflowId = () => selectedWorkflowId;

/** What a workflow's last run was, in words, for the folder's table: "Passed", "Failed: step 2 (Test)", or "" when it never ran. */
export function lastResult(lr) {
    if (!lr) return '';
    if (lr.status === 'failed' || lr.status === 'killed') { const fs = lr.failed_step; return lr.status === 'killed' ? 'Stopped' : fs ? `Failed: step ${Number(fs.number)} (${fs.name})` : 'Failed'; }
    return resultWords(lr);
}

let openRunId = null;

/** On a phone a workflow or a run is a screen of its own (data-phone-item, workflows.css); the folder's table is the page before it. */
function syncPhonePage() {
    const view = document.getElementById('workflows-view');
    if (!view) return;
    if (isPhoneLayout() && (selectedWorkflowId || openRunId)) view.setAttribute('data-phone-item', ''); else view.removeAttribute('data-phone-item');
}

// ── API helpers ────────────────────────────────────────────────────────

async function fetchWorkflows() {
    try {
        const data = await apiFetch('/api/workflows');
        workflows = data.workflows || [];
        for (const f of listeners) f();
    } catch (e) {
        console.error('Failed to fetch workflows:', e);
    }
}
/** Read the workflows again now (the folder asks when it is shown, and a page asks after what it changed). */
export const refreshWorkflows = fetchWorkflows;

async function fetchWorkflowDetail(id) {
    try {
        return await apiFetch(`/api/workflows/${id}`);
    } catch (e) {
        console.error('Failed to fetch workflow:', e);
        return null;
    }
}

const RUNS_PAGE = 10; // runs read at a time: the page opens with the newest and the footer reads the older ones (#8089: it showed the newest 10 and said nothing of the rest)
let runsPage = null; // the runs on screen for the open workflow: { workflowId, rows, total, busy }

async function fetchWorkflowRuns(workflowId, offset = 0) {
    try {
        const data = await apiFetch(`/api/workflows/${workflowId}/runs?limit=${RUNS_PAGE}&offset=${offset}`);
        return { runs: data.runs || [], total: data.total };
    } catch (e) {
        console.error('Failed to fetch workflow runs:', e);
        return null;
    }
}

/** The next RUNS_PAGE older runs of the workflow on screen, added under the ones shown. */
async function readOlderRuns(page) {
    if (runsPage !== page || page.busy) return;
    page.busy = true; redrawRuns(page);
    const more = await fetchWorkflowRuns(page.workflowId, page.rows.length);
    if (!more) showToast('The older runs could not be read', true);
    else {
        const have = new Set(page.rows.map(r => r.id));
        page.rows = page.rows.concat(more.runs.filter(r => !have.has(r.id)));
        page.total = more.runs.length && Number.isFinite(more.total) ? more.total : page.rows.length; // nothing older came: stop offering more
    }
    page.busy = false; redrawRuns(page);
}

function redrawRuns(page) {
    const host = document.getElementById('wf-run-table');
    if (host && runsPage === page) host.replaceChildren(workflowRunsTable(page));
}

async function fetchRunDetail(runId) {
    try {
        return await apiFetch(`/api/workflows/runs/${runId}`);
    } catch (e) {
        console.error('Failed to fetch run:', e);
        return null;
    }
}

// ── Initialization ─────────────────────────────────────────────────────

export const { launchWorkflowAgent, editWorkflowWithAgent } = WA;
export const { showWorkflowCreateModal, hideWorkflowCreateModal, editWorkflow, saveWorkflow } = WE;
WE.initWorkflowEditor({ fetchDetail: id => fetchWorkflowDetail(id), saved: editedId => { fetchWorkflows(); if (editedId) selectWorkflow(editedId); } }); // the names the lazy panel hands the page (app.js)

// ── Workflow detail ────────────────────────────────────────────────────

/** A workflow's or run's address (#3532, Automations' folder), unless the person has left Automations while it loaded. */
function noteWorkflows(id, run = 0) {
    if (document.body.getAttribute('data-nav-tab') === 'automations') note({ view: 'automations', folder: 'workflows', id: Number(id), ...(run ? { run: Number(run) } : {}) });
}

/** The folder's table is on screen: no workflow or run is open, and a run that was being followed is not any more. */
export function leaveWorkflowPage() {
    stopRunPolling();
    selectedWorkflowId = null; openRunId = null;
    syncPhonePage();
}

export async function selectWorkflow(id) {
    selectedWorkflowId = id; openRunId = null;
    stopRunPolling();

    const wf = await fetchWorkflowDetail(id);
    if (!wf) return false;
    noteWorkflows(id);

    // The workflow is the page now (a group's table may be on screen)
    showView('workflows-view');
    document.getElementById('wf-run-detail-container').style.display = 'none';
    document.getElementById('wf-detail-container').style.display = '';
    syncPhonePage();

    const first = await fetchWorkflowRuns(id) || { runs: [], total: 0 };
    runsPage = { workflowId: id, rows: first.runs, total: first.total, busy: false };
    renderWorkflowDetail(wf, first.runs);
}

/** A run's result for the runs table and the last-run line: "Passed", "Failed: step 2 (Test)", with the one-line reason from the server underneath. Step numbers come from 1 (#6530). */
function runResult(r) {
    const failed = r.status === 'failed' || r.status === 'killed';
    const name = r.status === 'killed' ? 'Stopped' : failed && r.failed_step ? `Failed: step ${Number(r.failed_step.number)} (${r.failed_step.name})` : resultWords(r);
    const chip = DT.chip(name, failed ? 'team-state-bad' : r.status === 'completed' ? 'goal-state-task-done' : r.status === 'running' ? 'goal-state-task-active' : '');
    const cell = DT.el('span'); cell.append(chip);
    const failure = runFailure(r); if (failure) cell.append(' ', DT.tag(`(${failure.short})`));
    if (failed && r.failure_reason) { chip.title = r.failure_reason; cell.append(DT.el('span', 'sr-only dt-run-reason', ` ${r.failure_reason}`)); } // one line a row (Goal #79): the reason is the chip's tooltip and said to assistive technology, not a second line
    return cell;
}

function workflowStepsTable(steps) {
    const table = DT.dataTable({ label: 'Workflow steps', rows: steps.map((s, i) => ({ ...s, position: i + 1 })), rowKey: s => s.position, bare: true, sortBar: false, oneLine: true, empty: { line: 'No steps yet.' },
        columns: [ // one line a row (Goal #79): the command is cut with an ellipsis (whole in its tooltip and the editor), a narrow list drops Type
            { key: 'step', label: 'Step', primary: true, width: '12rem', cell: s => { const cell = DT.el('span'); cell.append(DT.el('span', 'sr-only', `Step ${s.position}: `), document.createTextNode(s.name || `Step ${s.position}`)); return cell; } },
            { key: 'type', label: 'Type', width: '6rem', dropAt: 36, cell: s => DT.tag(s.type || 'shell') },
            { key: 'command', label: 'Command', width: 'grow', cell: s => { const what = (s.type || 'shell') === 'shell' ? s.command : s.prompt; if (!what) return '—'; const code = DT.el('code', 'wf-step-what', String(what).slice(0, 300)); code.title = String(what).slice(0, 300); return code; } },
        ],
    }); table.el.classList.add('wf-steps-table'); return table.el;
}

function workflowRunsTable(page) {
    const open = r => withId(r.id, selectWorkflowRun);
    const table = DT.dataTable({ label: 'Workflow runs', rows: page.rows, rowKey: r => r.id, bare: true, sortBar: false, oneLine: true, open, empty: { line: 'No runs yet.', hint: 'Runs are listed here once the workflow has run.' },
        footer: page.rows.length < page.total ? { text: `Showing the newest ${page.rows.length} of ${page.total} runs`, more: { label: 'Show older runs', busy: page.busy, run: () => readOlderRuns(page) } } : undefined,
        columns: [
            { key: 'started', label: 'Started', primary: true, width: '12rem', cell: r => { const time = DT.timeCell(r.started_at); const b = DT.primaryButton(time.textContent, `Open run #${r.id}`); b.title = time.title; b.addEventListener('click', () => open(r)); return b; } },
            { key: 'result', label: 'Result', width: 'grow', cell: runResult },
            { key: 'duration', label: 'Duration', width: '7rem', dropAt: 36, tone: 'tertiary', cell: r => r.duration_seconds != null ? (r.duration_seconds < 1 ? 'under 1s' : formatDuration(Math.round(r.duration_seconds), { unit: 's', dropZeroSeconds: true })) : '—' },
            { key: 'trigger', label: 'Trigger', width: '8rem', dropAt: 28, tone: 'tertiary', when: r => !!r.trigger_type, cell: r => r.trigger_type || '—' },
        ],
    }); table.el.classList.add('wf-runs-table'); return table.el;
}

function renderWorkflowDetail(wf, runs) {
    const container = document.getElementById('wf-detail');
    if (!container) return;

    const steps = wf.steps || [];
    const last = runs[0];
    const lastHtml = last && (last.status === 'failed' || last.status === 'killed') ? `<p class="wf-last-failed" role="status">
            The last run ${last.status === 'killed' ? 'was stopped' : 'failed'}${last.started_at ? ' ' + esc(whenText(last.started_at)) : ''}${last.failed_step ? `: step ${Number(last.failed_step.number)} (${esc(last.failed_step.name)})${last.failure_reason ? ': ' + esc(last.failure_reason) : ''}` : ''}.
            <button class="btn-link" data-on-click="wf-run" data-run-id="${Number(last.id)}">Open the failed run</button></p>` : '';

    // The page describes itself as the job page does (#9458): a status line (on or off, the last result), then the facts list (folder, time limit, when it was made)
    const status = [wf.enabled ? 'Active' : 'Disabled', lastWords(last)].filter(Boolean).join(' \u00b7 ');
    const factRows = [['Folder', wf.repo_path || 'not set'], ['Time limit', limitWords(wf.max_duration_s || 3600)], ...(wf.created_at ? [['Created', formatTime(wf.created_at)]] : [])];
    container.innerHTML = `
        <button type="button" class="back-link" id="wf-back-btn" data-on-click="automations-back" data-folder="workflows">\u2190 Workflows</button>
        <button type="button" class="back-link wf-phone-back" data-on-click="automations-back" data-folder="workflows">&larr; Workflows</button>
        <h2 class="wf-item-title" id="wf-title">${esc(wf.name)}</h2>
        <p class="item-meta wf-status-line">${esc(status)}</p>
        ${wf.description ? `<p class="wf-desc">${esc(wf.description)}</p>` : ''}
        <dl class="facts wf-facts"></dl>
        ${lastHtml}
        <div class="wf-steps-section">
            <h3 class="group-head group-head-lg">Steps (${steps.length})</h3>
            <div id="wf-step-table"></div>
        </div>
        <div class="wf-runs-section">
            <h3 class="group-head group-head-lg">Runs</h3>
            <div id="wf-run-table"></div>
        </div>
        <div class="item-bar wf-detail-actions">
            <div class="wf-more">
                <button class="btn btn-sm wf-more-btn" type="button" data-on-click="wf-more" aria-expanded="false" aria-controls="wf-more-menu-${Number(wf.id)}" aria-label="More for ${escAttr(wf.name)}">More</button>
                <div class="menu wf-more-menu" id="wf-more-menu-${Number(wf.id)}" hidden>
                    <button class="menu-item menu-item-danger" data-on-click="wf-delete" data-workflow-id="${Number(wf.id)}" data-name="${escAttr(wf.name)}">Delete</button>
                </div>
            </div>
            <button class="btn btn-sm" data-on-click="wf-edit-agent" data-workflow-id="${Number(wf.id)}">
                <span class="material-icons" style="font-size:var(--fs-lg)" aria-hidden="true">smart_toy</span> Edit with Agent
            </button>
            <button class="btn btn-sm" data-on-click="wf-edit" data-workflow-id="${Number(wf.id)}">Edit</button>
            <button class="btn btn-sm btn-primary" data-on-click="wf-trigger" data-workflow-id="${Number(wf.id)}">
                <span class="material-icons" style="font-size:var(--fs-lg)" aria-hidden="true">play_arrow</span> Run
            </button>
        </div>
    `;
    for (const [k, v] of factRows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; container.querySelector('.wf-facts').append(dt, dd); } // text, not markup
    container.querySelector('#wf-step-table').append(workflowStepsTable(steps));
    container.querySelector('#wf-run-table').append(workflowRunsTable(runsPage));
    foldWayBack(container, '.wf-phone-back', '#wf-title');
}

// ── Run detail ─────────────────────────────────────────────────────────

export async function selectWorkflowRun(runId, { workflowId } = {}) {
    stopRunPolling();

    const run = await fetchRunDetail(runId);
    if (!run) return false;
    const wfId = Number(run.workflow_id || workflowId || selectedWorkflowId);
    if (wfId) noteWorkflows(wfId, runId);

    // The run is the page now (a group's table may be on screen)
    openRunId = Number(runId); selectedWorkflowId = wfId || selectedWorkflowId;
    showView('workflows-view');
    document.getElementById('wf-detail-container').style.display = 'none';
    document.getElementById('wf-run-detail-container').style.display = '';
    syncPhonePage();

    renderRunDetail(run);

    // Poll if running
    if (run.status === 'running' || run.status === 'pending') {
        currentRunPollTimer = pollEvery(async () => {
            const updated = await fetchRunDetail(runId);
            if (!updated) { stopRunPolling(); return; }
            renderRunDetail(updated);
            if (updated.status !== 'running' && updated.status !== 'pending') {
                stopRunPolling();
                // Refresh workflow list data in background
                fetchWorkflows();
            }
        }, 3000);
    }
}

function stopRunPolling() {
    if (currentRunPollTimer) {
        clearInterval(currentRunPollTimer);
        currentRunPollTimer = null;
    }
}

function renderRunDetail(run) {
    const container = document.getElementById('wf-run-detail');
    if (!container) return;
    shownRun = run;

    const steps = run.steps || [];
    const isActive = run.status === 'running' || run.status === 'pending';

    const durationHtml = runDurationHtml(run);

    const progressBarHtml = runProgressHtml(run, steps);

    // The failing step's last stderr line, quoted after the run's error in the header.
    const signInFailure = runFailureHtml(run); // escaped where it is made (run_failure.js)
    const failedStep = steps.find(s => (s.status === 'failed' || s.status === 'killed') && s.error_tail && s.error_tail.trim());
    const errorExcerpt = failedStep ? failedStep.error_tail.trim().split('\n').pop().trim().slice(0, 200) : '';

    const stepsHtml = steps.map((s, i) => runStepHtml(run, s, i, steps.length)).join('');

    const killBtn = isActive
        ? `<button class="btn btn-sm" style="color:var(--error-text)" data-on-click="wf-kill-run" data-run-id="${Number(run.id)}">
            <span class="material-icons" style="font-size:var(--fs-lg)" aria-hidden="true">stop</span> Kill
          </button>`
        : '';

    const retriggerBtn = !isActive && run.workflow_id
        ? `<button class="btn btn-sm btn-primary" data-on-click="wf-trigger" data-workflow-id="${Number(run.workflow_id)}">
            <span class="material-icons" style="font-size:var(--fs-lg)" aria-hidden="true">replay</span> Re-run
          </button>`
        : '';

    // A run that is still going is drawn again every few seconds (#6639): what the person opened stays open and the control they were on keeps focus.
    const wasOpen = new Map([...container.querySelectorAll('.wf-run-step-output-toggle')].map(b => [b.getAttribute('aria-controls'), b.getAttribute('aria-expanded') === 'true']));
    const focusKey = document.activeElement && container.contains(document.activeElement) ? (document.activeElement.getAttribute('aria-controls') ? `c:${document.activeElement.getAttribute('aria-controls')}` : `a:${document.activeElement.dataset.onClick || ''}:${document.activeElement.dataset.session || document.activeElement.dataset.runId || ''}`) : '';
    // The run's own page: a link back to its workflow, its title, and its actions in the pinned bar (Re-run is the primary; Kill is all there is while it runs)
    const backHtml = run.workflow_id
        ? `<button type="button" class="back-link" id="wf-run-back" data-on-click="wf-select" data-workflow-id="${Number(run.workflow_id)}">\u2190 ${esc(run.workflow_name || 'Workflow')}</button>`
        : '';
    container.innerHTML = `
        ${backHtml}
        <button type="button" class="back-link wf-phone-back" data-on-click="automations-back" data-folder="workflows">&larr; Workflows</button>
        <h2 class="wf-item-title wf-run-title">${esc(run.workflow_name ? `${run.workflow_name}, run #${run.id}` : `Run #${run.id}`)}</h2>
        ${runMetaHtml(run, signInFailure, errorExcerpt)}
        ${progressBarHtml}
        <div class="wf-run-steps wf-timeline">${stepsHtml}</div>
        ${killBtn || retriggerBtn ? `<div class="item-bar wf-run-actions">${killBtn}${retriggerBtn}</div>` : ''}
    `;
    foldWayBack(container, '#wf-run-back, .wf-phone-back', '.wf-run-title'); // the workflow's link, or the list's when the run has no workflow
    for (const b of container.querySelectorAll('.wf-run-step-output-toggle')) {
        const id = b.getAttribute('aria-controls');
        if (!wasOpen.has(id)) continue;
        const open = wasOpen.get(id), out = document.getElementById(id);
        if (out) out.classList.toggle('wf-expanded', open);
        b.setAttribute('aria-expanded', String(open));
    }
    if (focusKey) {
        const again = [...container.querySelectorAll('button, [tabindex]')].find(e => focusKey.startsWith('c:') ? `c:${e.getAttribute('aria-controls')}` === focusKey : `a:${e.dataset.onClick || ''}:${e.dataset.session || e.dataset.runId || ''}` === focusKey);
        if (again) again.focus({ preventScroll: true });
    }
}

// ── Trigger ────────────────────────────────────────────────────────────

export async function triggerWorkflow(id, btn) {
    // The button says it is working and is off until the run exists (a second click would start a second run); a status line then says what started (#7471)
    const idle = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Starting\u2026'; }
    try {
        const result = await apiFetch(`/api/workflows/${id}/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger_type: 'ui' }),
        });
        const wf = workflows.find(w => Number(w.id) === Number(id));
        const name = wf ? wf.name : (shownRun && shownRun.workflow_name) || `workflow ${id}`;
        startedNote = { runId: Number(result.run_id), text: `Started ${name}` };
        sayStarted(startedNote.text);
        showToast(`Workflow triggered \u2014 run #${result.run_id}`);
        // Navigate to the run detail
        await selectWorkflowRun(result.run_id);
    } catch (e) {
        showToast('Failed to trigger workflow: ' + e.message, true);
    } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = idle; }
    }
}

let startedNote = null; // { runId, text }: "Started <name>", said once in the status line for a screen reader (the run's title names the workflow and the run)
function sayStarted(text) { const s = document.getElementById('wf-status'); if (s) s.textContent = text; }

// ── Kill ───────────────────────────────────────────────────────────────

// Kill asks first: it stops the run's agents mid-step and cannot be resumed (#3696).
 function confirmKillWorkflowRun(runId) {
    const name = shownRun && Number(shownRun.id) === runId && shownRun.workflow_name ? ` of workflow "${shownRun.workflow_name}"` : '';
    // Kill Run stops the step that is running; an agent step goes through the same kill as Kill Session, which keeps its terminal log (#4399, #4437).
    const agentRunning = !!shownRun && Number(shownRun.id) === runId && (shownRun.steps || []).some(s => s.type === 'agent' && s.status === 'running');
    window.showConfirmModal('Kill run', `Stop run #${runId}${name}? Its steps stop where they are and the run cannot be resumed.${agentRunning ? ' ' + KILL_LOG_NOTE : ''}`, () => killWorkflowRun(runId), undefined, { label: 'Kill run', danger: true });
}

export async function killWorkflowRun(runId) {
    try {
        await apiFetch(`/api/workflows/runs/${runId}/kill`, { method: 'POST' });
        showToast(`Run #${runId} killed`);
        // Refresh
        const updated = await fetchRunDetail(runId);
        if (updated) renderRunDetail(updated);
        stopRunPolling();
    } catch (e) {
        showToast('Failed to kill run: ' + e.message, true);
    }
}

// ── Delete ─────────────────────────────────────────────────────────────

export function deleteWorkflow(id, name) {
    window.showConfirmModal('Delete workflow', `Delete workflow "${name}"? This will also delete all run history.`, async () => {
        try {
            await apiFetch(`/api/workflows/${id}`, { method: 'DELETE' });
            showToast(`Deleted workflow "${name}"`);
            workflowsBackToList();
        } catch (e) {
            showToast('Failed to delete: ' + e.message, true);
        }
    }, undefined, { label: 'Delete workflow', danger: true });
}

// ── Navigation ─────────────────────────────────────────────────────────

export async function workflowsBackToList() {
    leaveWorkflowPage();
    (await importOnce('./automations.js')).backToFolder('workflows');
}

// The Workflows view's generated markup (#3645): data-on-* names, never code. The view's own
// buttons (back, build, create and the create dialog) register in app.js, which loads this module.
// Ids are checked (idOf) before use: a bad one does nothing.
// The More menu on a workflow's page closes on Escape (the focus goes back to More) and when the focus leaves it (#7177, from #7156's review).
function closeWorkflowMore(returnFocus) {
    for (const menu of document.querySelectorAll('.wf-more-menu:not([hidden])')) {
        const btn = document.querySelector(`.wf-more-btn[aria-controls="${menu.id}"]`);
        menu.hidden = true;
        if (btn) { btn.setAttribute('aria-expanded', 'false'); if (returnFocus) btn.focus(); }
    }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('.wf-more-menu:not([hidden])')) { e.preventDefault(); closeWorkflowMore(true); } });
document.addEventListener('focusin', e => { if (document.querySelector('.wf-more-menu:not([hidden])') && !(e.target instanceof Element && e.target.closest('.wf-more'))) closeWorkflowMore(false); });

registerActions({
    'wf-select': el => withId(el.dataset.workflowId, selectWorkflow),
    'wf-run': el => withId(el.dataset.runId, selectWorkflowRun),
    'wf-trigger': el => withId(el.dataset.workflowId, id => triggerWorkflow(id, el)),
    'wf-edit-agent': el => withId(el.dataset.workflowId, editWorkflowWithAgent),
    // Deleting still asks first (deleteWorkflow's confirmation dialog); the name is only shown in it.
    'wf-delete': el => withId(el.dataset.workflowId, id => deleteWorkflow(id, String(el.dataset.name || ''))),
    'wf-kill-run': el => withId(el.dataset.runId, confirmKillWorkflowRun),
    'wf-more': el => { const menu = document.getElementById(el.getAttribute('aria-controls')); if (!menu) return; menu.hidden = !menu.hidden; el.setAttribute('aria-expanded', String(!menu.hidden)); }, // Delete sits behind More, as on a job's page (#7156)
    'wf-output-toggle': el => {
        const out = document.getElementById(el.getAttribute('aria-controls'));
        if (out) el.setAttribute('aria-expanded', String(out.classList.toggle('wf-expanded')));
    },
    'wf-step-agent': (el, event) => { event.stopPropagation(); const s = textOf(el.dataset.session); if (s) selectLiveSession(s); },
});
