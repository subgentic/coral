/* Workflows: list, detail, run views, and CRUD */

import { escapeHtml as esc, escapeAttr as escAttr, showView, showToast } from './utils.js';
import { registerActions, withId, textOf } from './actions.js';
import { apiFetch } from './api.js';
import { selectLiveSession } from './sessions.js';
import { pollEvery } from './overload.js';
import { note, currentRoute } from './nav.js';
import { KILL_LOG_NOTE } from './render.js';
import { formatDuration } from './format.js';
import { runFailureHtml, runFailure } from './run_failure.js';
import { whenWords, resultWords, limitWords, runDot } from './job_words.js'; // the Jobs pages' words: one set for both
import { registerGroupSource, groupHeaderHtml, isGroupFolded, syncPaneGroupToggle, refreshGroupTable, openFirstGroupTable, backLinkHtml, foldWayBack } from './sidebar_groups.js';
import { onViewShown } from './view_switch.js';
import { isPhoneLayout } from './phone_layout.js';
import { importOnce } from './import_once.js';
import { whenText } from './when_text.js';

const DT = await importOnce('./data_table.js');
const WE = await importOnce('./workflow_editor.js'); // the create and edit form (#8360): a part of this panel that loads with it
const WR = await importOnce('./workflow_run_html.js'); // the run page's markup (#8360): pure builders that load with this panel
const { formatTime, runDurationHtml, runProgressHtml, runStepHtml, runMetaHtml } = WR;
const WA = await importOnce('./workflow_agent.js'); // Build with Agent and Edit with Agent (#8360): a part of this panel that loads with it
const workflowTableStates = new Map();

let workflows = [];
let selectedWorkflowId = null;
let currentRunPollTimer = null;
let shownRun = null; // the run renderRunDetail last drew, for the Kill confirmation's wording
let wfQuery = '';    // the sidebar search's text, lower case

// ── Groups (#7471): Active and Paused (a workflow that is switched off: it is finished, not a draft) ─────────
const WF_GROUPS = [{ key: 'active', label: 'Active', has: w => w.enabled }, { key: 'wf-paused', label: 'Paused', has: w => !w.enabled }];
const stepsOf = w => w.step_count || (w.steps ? w.steps.length : 0);
const wfMatches = w => !wfQuery || String(w.name || '').toLowerCase().includes(wfQuery) || String(w.description || '').toLowerCase().includes(wfQuery);
const wfGroups = () => WF_GROUPS.map(g => ({ ...g, items: workflows.filter(wfMatches).filter(g.has) })).filter(g => g.items.length);
const groupOfWorkflow = w => WF_GROUPS.find(g => g.has(w)) || WF_GROUPS[0];
export function filterWorkflows(value) { wfQuery = String(value || '').trim().toLowerCase(); renderWorkflowList(); }

/** What a workflow's last run was, in words, for the table and the sidebar row: "Passed", "Failed: step 2 (Test)", or "" when it never ran. */
function lastResult(lr) {
    if (!lr) return '';
    if (lr.status === 'failed' || lr.status === 'killed') { const fs = lr.failed_step; return lr.status === 'killed' ? 'Stopped' : fs ? `Failed: step ${Number(fs.number)} (${fs.name})` : 'Failed'; }
    return resultWords(lr);
}

registerGroupSource('workflows', {
    landing: true, // the page it opens on lists every group the sidebar has (#7722)
    keys: () => wfGroups().map(g => g.key),
    redraw: () => renderWorkflowList(),
    table: key => {
        const g = wfGroups().find(x => x.key === key);
        if (!g) return null;
        if (!workflowTableStates.has(key)) workflowTableStates.set(key, DT.tableState());
        return { title: g.label, rows: g.items, signature: JSON.stringify(g.items),
            node: () => DT.dataTable({
                label: `${g.label} workflows, ${g.items.length}`, rows: g.items, layout: 'fixed',
                rowKey: w => w.id, rowName: w => w.name, state: workflowTableStates.get(key),
                open: w => selectWorkflow(Number(w.id)),
                columns: [
                    { key: 'workflow', label: 'Workflow', field: 'name', primary: true, width: 'grow', line: 1, sort: true, cell: w => DT.primaryButton(w.name) },
                    { key: 'steps', label: 'Steps', numeric: true, width: '4rem', line: 2, tone: 'tertiary', sort: 'number', sortValue: stepsOf, cell: w => String(stepsOf(w)) },
                    { key: 'last-run', label: 'Last run', width: '8rem', line: 1, tone: 'tertiary', sort: 'date', sortValue: w => w.last_run?.started_at, cell: w => w.last_run?.started_at ? whenWords(w.last_run.started_at) : 'Never' },
                    { key: 'result', label: 'Result', width: '12rem', line: 2, sort: true, sortValue: w => lastResult(w.last_run), cell: w => lastResult(w.last_run) || 'No runs' },
                    { key: 'run', label: 'Run', width: '4rem', line: 2, cell: w => {
                        const b = DT.el('button', 'btn btn-small dt-action', 'Run'); b.type = 'button';
                        b.setAttribute('aria-label', `Run ${w.name}`);
                        b.addEventListener('click', () => triggerWorkflow(Number(w.id), b));
                        return b;
                    } },
                ],
            }).el,
            extra: { action: 'wf-build-agent', label: 'Build with Agent', icon: 'smart_toy', title: 'Starts an agent that builds the workflow with you' } };
    },
    toolbar: () => ({ search: { id: 'workflows-search', label: 'Search workflows' }, action: { name: 'wf-create', label: 'New workflow' }, menu: { noun: 'workflow', items: [{ name: 'wf-build-agent', label: 'Build with Agent' }] } }), // the create action on the page's toolbar line, Build with Agent its second way (#7723)
    isEmpty: () => false, // the tab opens its first table itself (fetchWorkflows)
    showList: () => workflowsBackToList(),
    empty: () => workflowsBackToList(),
});

// A group's table on screen is the page: no workflow or run is open (the sidebar's open row clears).
onViewShown(id => { if (id === 'group-table-view' && document.body.getAttribute('data-nav-tab') === 'workflows' && (selectedWorkflowId || openRunId)) { selectedWorkflowId = null; openRunId = null; stopRunPolling(); renderWorkflowList(); } });
let openRunId = null;

/** On a phone the list is the page and an open workflow or run is the screen after it (data-phone-item, workflows.css). */
function syncPhonePage() {
    const view = document.getElementById('workflows-view');
    if (!view) return;
    if (isPhoneLayout() && (selectedWorkflowId || openRunId)) view.setAttribute('data-phone-item', ''); else view.removeAttribute('data-phone-item');
    // With no workflow on a phone the empty page (its hint and Build with Agent) is shown under the list, or Build with Agent could not be reached
    if (isPhoneLayout() && !workflows.length && !selectedWorkflowId && !openRunId) view.setAttribute('data-phone-empty', ''); else view.removeAttribute('data-phone-empty');
}
export function workflowsPhoneBack() {
    selectedWorkflowId = null; openRunId = null; stopRunPolling();
    syncPhonePage();
    renderWorkflowList();
    document.querySelector('#wf-nav-list .row-btn')?.focus({ preventScroll: true });
}

// ── API helpers ────────────────────────────────────────────────────────

async function fetchWorkflows({ openFirst = false } = {}) {
    try {
        const data = await apiFetch('/api/workflows');
        workflows = data.workflows || [];
        renderWorkflowList();
        // The tab opens on its first group's table (a phone shows the list); with no workflow the page says so
        if (openFirst && !selectedWorkflowId && !openRunId) {
            showListPage();
            if (workflows.length && !isPhoneLayout()) openFirstGroupTable('workflows');
        }
        syncPhonePage();
    } catch (e) {
        console.error('Failed to fetch workflows:', e);
    }
}

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

export function showWorkflowsTab() {
    showView('workflows-view');
    if (selectedWorkflowId || openRunId) { syncPhonePage(); fetchWorkflows(); return; } // a workflow or a run is open: the tab returns to it
    showListPage();
    fetchWorkflows({ openFirst: true });
}

/** The page of no open workflow or run: only the empty line is in it (the table is its own view). */
function showListPage() {
    document.getElementById('wf-list-container').style.display = workflows.length ? 'none' : '';
    document.getElementById('wf-detail-container').style.display = 'none';
    document.getElementById('wf-run-detail-container').style.display = 'none';
}

export const { launchWorkflowAgent, editWorkflowWithAgent } = WA;
export const { showWorkflowCreateModal, hideWorkflowCreateModal, editWorkflow, workflowAddStep, workflowStepTypeChanged, saveWorkflow, checkWorkflowLimit } = WE;
WE.initWorkflowEditor({ fetchDetail: id => fetchWorkflowDetail(id), saved: editedId => { fetchWorkflows(); if (editedId) selectWorkflow(editedId); } }); // the names the lazy panel hands the page (app.js)

// ── Workflow list ──────────────────────────────────────────────────────

function renderWorkflowList() {
    const list = document.getElementById('wf-nav-list');
    if (!list) return;
    // The workflows by group in the sidebar: a row is its name and one muted line (its steps and how its last run went).
    const groups = wfGroups();
    const row = w => {
        const last = w.last_run ? [lastResult(w.last_run), w.last_run.started_at ? whenWords(w.last_run.started_at) : ''].filter(Boolean).join(' ') : 'never run';
        const n = stepsOf(w);
        const rd = runDot(w.last_run); // the dot a job's row has: one state, one look
        const open = Number(selectedWorkflowId) === Number(w.id);
        return `<li class="session-list-item wf-nav-row${escAttr(open ? ' active' : '')}"><button type="button" class="row-btn"${open ? ' aria-current="true"' : ''} data-on-click="wf-select" data-workflow-id="${Number(w.id)}"><span class="sched-row-head"><span class="sched-row-title"><span class="sched-dot sched-dot-${escAttr(rd.dot)}" role="img" aria-label="${escAttr(rd.words)}" title="${escAttr(rd.words)}"></span><span class="sched-row-name wf-nav-name">${esc(w.name)}</span></span></span><span class="sched-row-meta wf-nav-meta">${esc(`${n} step${n !== 1 ? 's' : ''} \u00b7 ${last}`)}</span></button></li>`;
    };
    list.innerHTML = groups.map(g => groupHeaderHtml('workflows', g.key, g.label, g.items.length) + (isGroupFolded('workflows', g.key) ? '' : g.items.map(row).join(''))).join('')
        || (workflows.length ? '<li class="empty-state">No workflow matches the search.</li>' : '<li class="empty-state">No workflows yet.</li>');
    // No workflow at all: the page says so (once there are some, the first group's table is the page)
    const empty = document.getElementById('wf-list-container');
    if (empty && !selectedWorkflowId && !openRunId) empty.style.display = workflows.length ? 'none' : '';
    syncPaneGroupToggle('workflows');
    refreshGroupTable('workflows');
}

// ── Workflow detail ────────────────────────────────────────────────────

/** A workflow's or run's page (#3532), unless the user has left Workflows while it loaded. */
function noteWorkflows(route) {
    if (currentRoute()?.view === 'workflows') note(route);
}

export async function selectWorkflow(id) {
    selectedWorkflowId = id; openRunId = null;
    stopRunPolling();

    const wf = await fetchWorkflowDetail(id);
    if (!wf) return false;
    noteWorkflows({ view: 'workflows', id: Number(id) });

    // The workflow is the page now (a group's table may be on screen)
    showView('workflows-view');
    document.getElementById('wf-list-container').style.display = 'none';
    document.getElementById('wf-run-detail-container').style.display = 'none';
    document.getElementById('wf-detail-container').style.display = '';
    syncPhonePage();
    renderWorkflowList(); // the open row says so

    const first = await fetchWorkflowRuns(id) || { runs: [], total: 0 };
    runsPage = { workflowId: id, rows: first.runs, total: first.total, busy: false };
    renderWorkflowDetail(wf, first.runs);
}

/** A run's result for the runs table and the last-run line: "Passed", "Failed: step 2 (Test)", with the one-line reason from the server underneath. Step numbers come from 1 (#6530). */
function runResult(r) {
    const failed = r.status === 'failed' || r.status === 'killed';
    const name = r.status === 'killed' ? 'Stopped' : failed && r.failed_step ? `Failed: step ${Number(r.failed_step.number)} (${r.failed_step.name})` : resultWords(r);
    const cell = DT.el('span'); cell.append(DT.chip(name, failed ? 'goal-state-task-blocked' : r.status === 'completed' ? 'goal-state-task-done' : r.status === 'running' ? 'goal-state-task-active' : ''));
    const failure = runFailure(r); if (failure) cell.append(' ', DT.tag(`(${failure.short})`));
    return cell;
}

function workflowStepsTable(steps) {
    const table = DT.dataTable({ label: 'Workflow steps', rows: steps.map((s, i) => ({ ...s, position: i + 1 })), rowKey: s => s.position, bare: true, sortBar: false, empty: { line: 'No steps yet.' },
        columns: [
            { key: 'step', label: 'Step', primary: true, width: 'grow', line: 1, cell: s => { const cell = DT.el('span'); cell.append(DT.el('span', 'sr-only', `Step ${s.position}: `), document.createTextNode(s.name || `Step ${s.position}`)); return cell; } },
            { key: 'type', label: 'Type', line: 2, cell: s => DT.tag(s.type || 'shell') },
            { key: 'command', label: 'Command', line: 2, nowrap: false, cell: s => { const what = (s.type || 'shell') === 'shell' ? s.command : s.prompt; return what ? DT.el('code', 'wf-step-what', String(what).slice(0, 300)) : '—'; } },
        ],
    }); table.el.classList.add('wf-steps-table'); return table.el;
}

function workflowRunsTable(page) {
    const open = r => withId(r.id, selectWorkflowRun);
    const table = DT.dataTable({ label: 'Workflow runs', rows: page.rows, rowKey: r => r.id, bare: true, sortBar: false, open, empty: { line: 'No runs yet.' },
        footer: page.rows.length < page.total ? { text: `Showing the newest ${page.rows.length} of ${page.total} runs`, more: { label: 'Show older runs', busy: page.busy, run: () => readOlderRuns(page) } } : undefined,
        columns: [
            { key: 'started', label: 'Started', primary: true, width: 'grow', line: 1, cell: r => { const time = DT.timeCell(r.started_at); const b = DT.primaryButton(time.textContent, `Open run #${r.id}`); b.title = time.title; b.addEventListener('click', () => open(r)); return b; } },
            { key: 'result', label: 'Result', line: 2, nowrap: false, cell: runResult, subtitle: r => (r.status === 'failed' || r.status === 'killed') ? r.failure_reason : '' },
            { key: 'duration', label: 'Duration', line: 2, tone: 'tertiary', cell: r => r.duration_seconds != null ? (r.duration_seconds < 1 ? 'under 1s' : formatDuration(Math.round(r.duration_seconds), { unit: 's', dropZeroSeconds: true })) : '—' },
            { key: 'trigger', label: 'Trigger', line: 2, tone: 'tertiary', when: r => !!r.trigger_type, cell: r => r.trigger_type || '—' },
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

    const group = groupOfWorkflow(wf);
    // One facts line under the name (folder, time limit, when it was made, and that it is off)
    const facts = [`Folder ${wf.repo_path || 'not set'}`, `Time limit ${limitWords(wf.max_duration_s || 3600)}`, wf.created_at ? `Created ${formatTime(wf.created_at)}` : '', wf.enabled ? '' : 'Disabled'].filter(Boolean).join(' \u00b7 ');
    container.innerHTML = `
        ${backLinkHtml('workflows', group.key, group.label, 'wf-back-btn')}
        <button type="button" class="group-back wf-phone-back" data-on-click="wf-phone-back">&larr; Workflows</button>
        <h2 class="wf-item-title" id="wf-title">${esc(wf.name)}</h2>
        <p class="item-meta wf-facts-line">${esc(facts)}</p>
        ${wf.description ? `<p class="wf-desc">${esc(wf.description)}</p>` : ''}
        ${lastHtml}
        <div class="wf-steps-section">
            <h3>Steps (${steps.length})</h3>
            <div id="wf-step-table"></div>
        </div>
        <div class="wf-runs-section">
            <h3>Runs</h3>
            <div id="wf-run-table"></div>
        </div>
        <div class="item-bar wf-detail-actions">
            <div class="wf-more">
                <button class="btn btn-sm wf-more-btn" type="button" data-on-click="wf-more" aria-expanded="false" aria-controls="wf-more-menu-${Number(wf.id)}" aria-label="More for ${escAttr(wf.name)}">More</button>
                <div class="wf-more-menu" id="wf-more-menu-${Number(wf.id)}" hidden>
                    <button class="btn btn-sm btn-warning" data-on-click="wf-delete" data-workflow-id="${Number(wf.id)}" data-name="${escAttr(wf.name)}">Delete</button>
                </div>
            </div>
            <button class="btn btn-sm" data-on-click="wf-edit-agent" data-workflow-id="${Number(wf.id)}">
                <span class="material-icons" style="font-size:0.875rem" aria-hidden="true">smart_toy</span> Edit with Agent
            </button>
            <button class="btn btn-sm" data-on-click="wf-edit" data-workflow-id="${Number(wf.id)}">Edit</button>
            <button class="btn btn-sm btn-primary" data-on-click="wf-trigger" data-workflow-id="${Number(wf.id)}">
                <span class="material-icons" style="font-size:0.875rem" aria-hidden="true">play_arrow</span> Run
            </button>
        </div>
    `;
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
    if (wfId) noteWorkflows({ view: 'workflows', id: wfId, run: Number(runId) });

    // The run is the page now (a group's table may be on screen)
    openRunId = Number(runId); selectedWorkflowId = wfId || selectedWorkflowId;
    showView('workflows-view');
    document.getElementById('wf-list-container').style.display = 'none';
    document.getElementById('wf-detail-container').style.display = 'none';
    document.getElementById('wf-run-detail-container').style.display = '';
    syncPhonePage();
    renderWorkflowList();

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
            <span class="material-icons" style="font-size:0.875rem" aria-hidden="true">stop</span> Kill
          </button>`
        : '';

    const retriggerBtn = !isActive && run.workflow_id
        ? `<button class="btn btn-sm btn-primary" data-on-click="wf-trigger" data-workflow-id="${Number(run.workflow_id)}">
            <span class="material-icons" style="font-size:0.875rem" aria-hidden="true">replay</span> Re-run
          </button>`
        : '';

    // A run that is still going is drawn again every few seconds (#6639): what the person opened stays open and the control they were on keeps focus.
    const wasOpen = new Map([...container.querySelectorAll('.wf-run-step-output-toggle')].map(b => [b.getAttribute('aria-controls'), b.getAttribute('aria-expanded') === 'true']));
    const focusKey = document.activeElement && container.contains(document.activeElement) ? (document.activeElement.getAttribute('aria-controls') ? `c:${document.activeElement.getAttribute('aria-controls')}` : `a:${document.activeElement.dataset.onClick || ''}:${document.activeElement.dataset.session || document.activeElement.dataset.runId || ''}`) : '';
    // The run's own page: a link back to its workflow, its title, and its actions in the pinned bar (Re-run is the primary; Kill is all there is while it runs)
    const backHtml = run.workflow_id
        ? `<button type="button" class="group-back" id="wf-run-back" data-on-click="wf-select" data-workflow-id="${Number(run.workflow_id)}">\u2190 ${esc(run.workflow_name || 'Workflow')}</button>`
        : '';
    container.innerHTML = `
        ${backHtml}
        <button type="button" class="group-back wf-phone-back" data-on-click="wf-phone-back">&larr; Workflows</button>
        <h2 class="wf-item-title wf-run-title">Run #${run.id}</h2>
        ${startedNote && startedNote.runId === Number(run.id) ? `<p class="item-meta wf-started-line">${esc(startedNote.text)}</p>` : ''}
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

let startedNote = null; // { runId, text }: "Started <name>", shown on the run's page it opened
function sayStarted(text) { const s = document.getElementById('wf-status'); if (s) s.textContent = text; }

// ── Kill ───────────────────────────────────────────────────────────────

// Kill asks first: it stops the run's agents mid-step and cannot be resumed (#3696).
 function confirmKillWorkflowRun(runId) {
    const name = shownRun && Number(shownRun.id) === runId && shownRun.workflow_name ? ` of workflow "${shownRun.workflow_name}"` : '';
    // Kill Run stops the step that is running; an agent step goes through the same kill as Kill Session, which keeps its terminal log (#4399, #4437).
    const agentRunning = !!shownRun && Number(shownRun.id) === runId && (shownRun.steps || []).some(s => s.type === 'agent' && s.status === 'running');
    window.showConfirmModal('Kill Run', `Stop run #${runId}${name}? Its steps stop where they are and the run cannot be resumed.${agentRunning ? ' ' + KILL_LOG_NOTE : ''}`, () => killWorkflowRun(runId));
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
    window.showConfirmModal('Delete Workflow', `Delete workflow "${name}"? This will also delete all run history.`, async () => {
        try {
            await apiFetch(`/api/workflows/${id}`, { method: 'DELETE' });
            showToast(`Deleted workflow "${name}"`);
            workflowsBackToList();
        } catch (e) {
            showToast('Failed to delete: ' + e.message, true);
        }
    });
}

// ── Navigation ─────────────────────────────────────────────────────────

export function workflowsBackToList() {
    noteWorkflows({ view: 'workflows' });
    stopRunPolling();
    selectedWorkflowId = null; openRunId = null;
    showView('workflows-view');
    showListPage();
    syncPhonePage();
    fetchWorkflows({ openFirst: true });
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
