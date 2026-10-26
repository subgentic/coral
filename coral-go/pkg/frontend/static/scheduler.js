/* Scheduler: scheduled jobs sidebar list, job detail view, and CRUD operations */

import { isPhoneLayout } from './phone_layout.js';
import { state } from './state.js';
import { escapeHtml, escapeAttr, showToast, showView, setRowCurrent } from './utils.js';
import { registerActions, withId, uuidOf } from './actions.js';
import { pollEvery } from './overload.js';
import { showJobModal, editScheduledJob } from './job_form.js';
import { formatDuration as fmtDuration } from './format.js';
import { runFailure } from './run_failure.js';
import { cronWords, atWords, awayWords, whenWords, resultWords, reasonWords, lastWords, limitWords, exitNote, resultLine, runDot } from './job_words.js';
import { updateJobsSectionCount } from './live_jobs.js';
import { registerGroupSource, groupHeaderHtml, isGroupFolded, syncPaneGroupToggle, refreshGroupTable, backLinkHtml, foldWayBack } from './sidebar_groups.js';
import * as DT from './data_table.js';

const jobTableStates = new Map();

let scheduledJobs = [];
let selectedJobId = null;

// ── API helpers ──────────────────────────────────────────────────────────

// A job whose run fails for its worktree or branch is said once in the status that is always in the page (#6707): which job and why. The first list read only sets the baseline, so what failed
// before this page was opened is on its row, not announced. jobsSeen maps a job to its last run's identity and status.
let jobsSeen = null;
const runError = r => String(r.error_msg || r.error || '').trim(); // the run's error as the server words it (error_msg; a plain sentence when error_code is set)
const runKey = job => { const r = job.last_run; return r ? `${r.id ?? r.started_at ?? ''}:${r.status}` : ''; };
function announceFailedRuns(before) {
    const now = new Map(scheduledJobs.map(j => [j.id, runKey(j)]));
    jobsSeen = now;
    if (!before) return;
    const said = scheduledJobs.filter(j => j.last_run && j.last_run.status === 'failed' && before.get(j.id) !== now.get(j.id))
        .map(j => `${j.name}: the last run failed${j.last_run.error_code && runError(j.last_run) ? `. ${runError(j.last_run)}` : '.'}`);
    const live = document.getElementById('jobs-live');
    if (said.length && live) live.textContent = said.join(' ');
}

async function fetchJobs() {
    try {
        const resp = await fetch('/api/scheduled/jobs');
        const data = await resp.json();
        const before = jobsSeen;
        scheduledJobs = data.jobs || [];
        renderJobsSidebar();
        announceFailedRuns(before);
    } catch (e) {
        console.error('Failed to fetch scheduled jobs:', e);
    }
}

async function fetchJobRuns(jobId) {
    try {
        const resp = await fetch(`/api/scheduled/jobs/${jobId}/runs?limit=20`);
        const data = await resp.json();
        return data.runs || [];
    } catch (e) {
        console.error('Failed to fetch runs:', e);
        return [];
    }
}

// ── Sidebar rendering ────────────────────────────────────────────────────

// ── Groups (#7443): Active and Paused; a group's name opens it as a table in the centre ──

let jobsQuery = ''; // the search box's text, lower case
const matchesQuery = job => !jobsQuery || String(job.name || '').toLowerCase().includes(jobsQuery);
export function filterJobs(value) { jobsQuery = String(value || '').trim().toLowerCase(); renderJobsSidebar(); }

const JOB_GROUPS = [{ key: 'active', label: 'Active', has: job => job.enabled }, { key: 'paused', label: 'Paused', has: job => !job.enabled }];
const jobGroups = () => JOB_GROUPS.map(g => ({ ...g, jobs: scheduledJobs.filter(matchesQuery).filter(g.has) })).filter(g => g.jobs.length);

const scheduleOf = job => cronWords(job.cron_expr) + (job.timezone ? ` (${job.timezone})` : '');
const nextOf = job => !job.enabled ? 'Paused' : job.next_fire_at ? awayWords(job.next_fire_at) : 'Not scheduled';

registerGroupSource('jobs', {
    landing: true, // the page it opens on lists every group the sidebar has (#7722)
    keys: () => jobGroups().map(g => g.key),
    redraw: () => renderJobsSidebar(),
    toolbar: () => ({ search: { id: 'jobs-search', label: 'Search jobs' }, action: { name: 'job-new', label: 'New job' } }), // the create action on the page's toolbar line (#7723)
    table: key => {
        const g = jobGroups().find(x => x.key === key);
        if (!g) return null;
        if (!jobTableStates.has(key)) jobTableStates.set(key, DT.tableState());
        return { title: g.label, rows: g.jobs,
            signature: JSON.stringify(g.jobs.map(job => [job, lastWords(job.last_run), nextOf(job)])),
            node: () => DT.dataTable({
                label: `${g.label} jobs, ${g.jobs.length}`, rows: g.jobs, layout: 'fixed',
                rowKey: job => job.id, rowName: job => job.name, state: jobTableStates.get(key),
                open: job => selectScheduledJob(Number(job.id)),
                columns: [
                    { key: 'job', label: 'Job', field: 'name', primary: true, width: 'grow', line: 1, sort: true, cell: job => DT.primaryButton(job.name) },
                    { key: 'schedule', label: 'Schedule', width: '12rem', line: 2, sort: true, sortValue: scheduleOf, cell: scheduleOf },
                    { key: 'last-run', label: 'Last run', width: '9rem', line: 2, tone: 'tertiary', sort: 'date', sortValue: job => job.last_run?.started_at, cell: job => {
                        const run = job.last_run;
                        if (!run) return lastWords(run);
                        const cls = run.status === 'failed' ? 'team-state-bad' : run.status === 'running' ? 'goal-state-task-active' : run.status === 'completed' && run.exit_reason !== 'ended_while_coral_was_down' ? 'goal-state-task-done' : '';
                        return DT.chip(lastWords(run), cls);
                    } },
                    { key: 'next', label: 'Next', width: '7rem', line: 1, tone: 'tertiary', sort: 'date', sortValue: job => job.enabled ? job.next_fire_at : '', cell: job => {
                        const cell = job.enabled ? DT.el('span', 'dt-time', nextOf(job)) : DT.chip('Paused');
                        if (job.enabled && job.next_fire_at) cell.title = `Next run ${atWords(job.next_fire_at)} your time`;
                        return cell;
                    } },
                ],
            }).el,
        };
    },
    isEmpty: () => document.getElementById('scheduler-view')?.style.display === 'block' && !!document.querySelector('#scheduler-detail > .sched-empty-hint') && document.body.getAttribute('data-nav-tab') === 'jobs',
    showList: () => window.switchNavTab?.('jobs'),
    empty: () => window.switchNavTab?.('jobs'),
});

/** One job's row in the list. */
function jobRowHtml(job) {
    const active = selectedJobId === job.id ? 'active' : '';
    const lastStatus = job.last_run ? job.last_run.status : '';
    const unseenRun = lastStatus === 'completed' && job.last_run.exit_reason === 'ended_while_coral_was_down'; // done, but Coral did not see the result: not the green of a pass (#6907)
    const rd = runDot(job.last_run); // the same dot and words a workflow's row has
    const dot = unseenRun ? 'none' : rd.dot;
    const dotWords = unseenRun ? 'Last run completed, result not seen' : rd.words; // the dot is a coloured circle: its words say what it means
    const paused = job.enabled ? '' : `<span class="sched-chip">${job.paused_reason ? 'paused: failing' : 'paused'}</span>`;
    // A job whose scheduling works but whose every run fails otherwise looks identical to a healthy one here.
    const fails = job.consecutive_failures || 0;
    const failBadge = fails >= 2
        ? `<span class="sched-fail-badge" title="The last ${escapeAttr(fails)} runs failed">${fails} failed</span>`
        : '';
    const meta = [cronWords(job.cron_expr) + (job.timezone ? ` (${job.timezone})` : ''), lastWords(job.last_run), job.enabled && job.next_fire_at ? `next ${awayWords(job.next_fire_at)}` : ''].filter(Boolean).join(' · ');
    // A run that failed for its folder or branch says so on the row, in the server's plain sentence (error_code names those), not "never run" with the cause out of sight (#6707).
    const problem = job.last_run && job.last_run.status === 'failed' ? (job.last_run.error_code ? runError(job.last_run) : reasonWords(job.last_run)) : ''; // any failed run says why (#6956): the server's plain sentence for a coded one, the run's own error for the rest
    const note = exitNote(job.last_run); // what the last run's exit_reason adds to its status (#6907): on the row as text, not only on hover
    const nextTitle = job.enabled && job.next_fire_at ? `Next run ${atWords(job.next_fire_at)} your time` : '';
    return `<li class="session-list-item sched-row ${escapeAttr(active)}" data-on-click="job-select" data-job-id="${Number(job.id)}" title="${escapeAttr(nextTitle)}"><button type="button" class="row-btn"${active ? ' aria-current="true"' : ''}>
        <span class="sched-row-head"><span class="sched-row-title"><span class="sched-dot sched-dot-${dot}" role="img" aria-label="${escapeAttr(dotWords)}" title="${escapeAttr(dotWords)}"></span><span class="sched-row-name">${escapeHtml(job.name)}</span></span>${paused}${failBadge}</span>
        <span class="sched-row-meta">${escapeHtml(meta)}</span>
        ${problem ? `<span class="sched-row-problem">${escapeHtml(problem)}</span>` : note && !problem ? `<span class="sched-row-note">${escapeHtml(note)}</span>` : ''}
    </button></li>`;
}

function renderJobsSidebar() {
    const list = document.getElementById('scheduled-jobs-list');
    if (!list) return;
    const hint = document.querySelector('#scheduler-detail > .sched-empty-hint'); // the empty pane says what to do (#6956)
    if (hint) {
        const line = hint.querySelector('.empty-line'), more = hint.querySelector('.empty-hint');
        if (line) line.textContent = scheduledJobs.length ? 'Choose a job in the list.' : 'No jobs yet.';
        if (more) more.textContent = scheduledJobs.length ? 'It shows what the job does and how its runs went.' : 'New job, in the sidebar, schedules one.';
    }
    const groups = jobGroups();
    if (!groups.length) {
        list.innerHTML = scheduledJobs.length ? '<li class="empty-state">No job matches the search.</li>' : '<li class="empty-state">No jobs yet. New job schedules one.</li>';
        syncPaneGroupToggle('jobs');
        refreshGroupTable('jobs');
        updateJobsSectionCount();
        return;
    }
    // Every job (#6521): its schedule, its last result and its next run in words, under its state's group.
    list.innerHTML = groups.map(g => groupHeaderHtml('jobs', g.key, g.label, g.jobs.length) + (isGroupFolded('jobs', g.key) ? '' : g.jobs.map(jobRowHtml).join(''))).join('');
    syncPaneGroupToggle('jobs');
    refreshGroupTable('jobs');
    updateJobsSectionCount();
}

// ── Job detail view ──────────────────────────────────────────────────────

let workflowsById = null; // the workflows a job can run, by id, for the name and the step count

async function loadWorkflowsById() {
    try {
        const resp = await fetch('/api/workflows');
        const data = await resp.json();
        workflowsById = new Map((data.workflows || []).map(w => [Number(w.id), w]));
    } catch { workflowsById = workflowsById || new Map(); }
    return workflowsById;
}

export async function selectScheduledJob(jobId) {
    selectedJobId = jobId;
    renderJobsSidebar();

    const job = scheduledJobs.find(j => j.id === jobId);
    if (!job) return;

    // Hide other views, show scheduler view
    showView("scheduler-view");

    // Deselect live/history sessions
    state.currentSession = null;
    document.querySelectorAll('.session-list-item.active').forEach(el => {
        if (!el.closest('#scheduled-jobs-list')) setRowCurrent(el, false);
    });

    const [runs] = await Promise.all([fetchJobRuns(jobId), job.workflow_id ? loadWorkflowsById() : null]);
    renderJobDetail(job, runs);
    if (isPhoneLayout()) { document.getElementById('scheduler-view')?.setAttribute('data-phone-item', ''); document.getElementById('scheduler-detail')?.scrollIntoView({ block: 'start' }); } // a phone shows the job's page as its own screen (#7443); the list is the screen before it (#6139)
}

function renderJobDetail(job, runs) {
    const container = document.getElementById('scheduler-detail');
    if (!container) return;

    const isWorkflow = !!job.workflow_id;
    const wf = isWorkflow && workflowsById ? workflowsById.get(Number(job.workflow_id)) : null;
    const wfName = wf ? wf.name : (job.workflow_name || `workflow ${job.workflow_id}`);
    const doesHtml = isWorkflow
        ? `Workflow <a href="#" data-on-click="job-workflow" data-workflow-id="${Number(job.workflow_id)}" class="sched-link">${escapeHtml(wfName)}</a>${wf && Array.isArray(wf.steps) ? ` (${wf.steps.length} step${wf.steps.length === 1 ? '' : 's'})` : ''}`
        : `${escapeHtml(AGENT_NAMES[job.agent_type] || job.agent_type || 'Agent')} agent${job.repo_path ? ` in <span class="sched-path">${escapeHtml(job.repo_path)}</span>` : ''}`;

    const history = isWorkflow && job.workflow_runs?.length ? job.workflow_runs : runs;
    const workflowHistory = !!(isWorkflow && job.workflow_runs?.length);

    // The failure comes first (#6521): a job that fires on schedule and fails every time otherwise looks fine until the run history is opened.
    const fails = job.consecutive_failures || 0;
    const last = job.last_run || null;
    // A run refused for want of a sign-in does not count as a failure (the job keeps its schedule and runs again once signed in), so it has its own banner (#5471).
    const noSignIn = runFailure(last);
    const why = reasonWords(last);
    const when = last && (last.finished_at || last.started_at) ? ` ${whenWords(last.finished_at || last.started_at)}` : '';
    const failBanner = noSignIn
        ? `<div class="sched-fail-banner" role="status">
             <strong>The last run did not start: ${escapeHtml(noSignIn.text)}.</strong>
             ${escapeHtml(noSignIn.hint)} This job keeps its schedule and ${escapeHtml(noSignIn.again)}.
           </div>`
        : fails >= 1
        ? `<div class="sched-fail-banner" role="status">
             <strong>${fails === 1 ? 'The last run failed' : `The last ${fails} runs failed`}</strong>${escapeHtml(when)}${why ? `: ${escapeHtml(why)}` : ''}. ${!job.enabled ? (job.paused_reason ? 'It is paused. Fix the cause, then press Enable.' : 'It is paused. Press Enable to run it again.') : 'It is still scheduled.'}
           </div>`
        : '';

    const settingsRows = [
        job.repo_path ? ['Folder', `<span class="sched-path">${escapeHtml(job.repo_path)}</span>`] : null,
        !isWorkflow ? ['Base branch', escapeHtml(job.base_branch || "The repo's current branch")] : null,
        ['Time limit', escapeHtml(limitWords(job.max_duration_s) || `${job.max_duration_s} seconds`)],
        !isWorkflow ? ['Cleanup worktree', job.cleanup_worktree ? 'Yes' : 'No'] : null,
        job.flags ? ['Flags', `<code>${escapeHtml(job.flags)}</code>`] : null,
    ].filter(Boolean);

    const moreId = `sched-more-${Number(job.id)}`;
    const group = JOB_GROUPS.find(g => g.has(job));
    const status = [job.enabled ? 'Active' : (job.paused_reason ? 'Paused: failing' : 'Paused'), lastWords(job.last_run), job.enabled && job.next_fire_at ? `next ${awayWords(job.next_fire_at)}` : ''].filter(Boolean).join(' \u00b7 ');
    // A short prompt is shown; a long one is folded (it would push the runs off the page)
    const longPrompt = (job.prompt || '').length > 600 || (job.prompt || '').split('\n').length > 10;
    const promptHtml = !isWorkflow && job.prompt
        ? (longPrompt
            ? `<details class="disclosure sched-prompt-section"><summary>Prompt</summary><pre class="sched-prompt">${escapeHtml(job.prompt)}</pre></details>`
            : `<section class="sched-prompt-section sched-prompt-shown"><h3>Prompt</h3><pre class="sched-prompt">${escapeHtml(job.prompt)}</pre></section>`)
        : '';
    container.innerHTML = `
        ${backLinkHtml('jobs', group.key, group.label)}
        <button type="button" class="sched-back" data-on-click="job-back">&larr; Jobs</button>
        ${failBanner}
        <div class="sched-header">
            <h2>${escapeHtml(job.name)}</h2>
        </div>
        <p class="item-meta sched-status-line">${escapeHtml(status)}</p>
        ${job.description ? `<p class="sched-desc">${escapeHtml(job.description)}</p>` : ''}
        <dl class="sched-facts">
            <dt>Schedule</dt><dd title="${escapeAttr(job.cron_expr)}">${escapeHtml(cronWords(job.cron_expr))}${job.timezone ? ` (${escapeHtml(job.timezone)})` : ''}</dd>
            ${job.enabled
                ? (job.next_fire_at ? `<dt>Next</dt><dd title="${escapeAttr(awayWords(job.next_fire_at))}">${escapeHtml(atWords(job.next_fire_at))} your time</dd>` : '<dt>Next</dt><dd>not scheduled</dd>')
                : `<dt>Paused</dt><dd>${job.paused_reason ? `${escapeHtml(job.paused_reason)}. Fix the cause, then Enable to resume.` : 'Enable it to run on schedule.'}</dd>`}
            <dt>Does</dt><dd>${doesHtml}</dd>
        </dl>
        ${promptHtml}
        <details class="disclosure sched-settings">
            <summary>Settings: ${isWorkflow ? 'folder, time limit' : 'folder, branch, time limit'}</summary>
            <dl class="sched-facts">${settingsRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        </details>
        <div class="sched-runs-section">
            <h3>Runs</h3>
            <div id="sched-run-history"></div>
        </div>
        <div class="item-bar sched-actions">
            <div class="sched-more">
                <button class="btn btn-small sched-more-btn" type="button" data-on-click="job-more" aria-expanded="false" aria-controls="${escapeAttr(moreId)}" aria-label="More for ${escapeAttr(job.name)}">More</button>
                <div class="sched-more-menu" id="${escapeAttr(moreId)}" hidden>
                    <button class="btn btn-small btn-warning sched-delete" type="button" data-on-click="job-delete" data-job-id="${Number(job.id)}" aria-label="Delete ${escapeAttr(job.name)}">Delete</button>
                </div>
            </div>
            <button class="btn btn-small" data-on-click="job-edit" data-job-id="${Number(job.id)}">Edit</button>
            <button class="btn btn-small btn-primary" data-on-click="job-toggle" data-job-id="${Number(job.id)}">${job.enabled ? 'Pause' : 'Enable'}</button>
        </div>
    `;
    container.querySelector('#sched-run-history').append(renderRunsTable(history, workflowHistory));
    foldWayBack(container, '.sched-back', '.sched-header');
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Antigravity', pi: 'Pi' };

function resultCell(r) {
    const unseen = r.status === 'completed' && r.exit_reason === 'ended_while_coral_was_down';
    const cls = unseen ? '' : r.status === 'completed' ? 'goal-state-task-done' : r.status === 'failed' || r.status === 'killed' ? 'team-state-bad' : r.status === 'running' ? 'goal-state-task-active' : '';
    const cell = DT.el('span'), chip = DT.chip(resultWords(r), cls); chip.classList.add('sched-status'); cell.append(chip);
    const failure = runFailure(r); if (failure) cell.append(' ', DT.tag(`(${failure.short})`));
    return cell;
}
const tookOf = (r) => (r.started_at && r.finished_at ? formatDuration(new Date(r.finished_at) - new Date(r.started_at)) : r.started_at ? 'running...' : '-');

// Both job kinds share the table; workflow runs open their run and agent runs link to their conversation.
function renderRunsTable(runs, workflowHistory) {
    const open = r => withId(r.id, id => window.selectWorkflowRun(id));
    const table = DT.dataTable({ label: 'Job runs', rows: runs, rowKey: r => r.id, bare: true, sortBar: false,
        open: workflowHistory ? open : undefined, empty: { line: 'No runs yet.' },
        columns: [
            { key: 'started', label: 'Started', primary: true, width: 'grow', line: 1, cell: r => {
                const time = DT.timeCell(workflowHistory ? r.started_at || r.created_at : r.scheduled_at || r.started_at);
                if (!workflowHistory) return time;
                const b = DT.primaryButton(time.textContent, `Open run #${r.id}`); b.title = time.title; b.addEventListener('click', () => open(r)); return b;
            } },
            { key: 'result', label: 'Result', line: 2, nowrap: false, cell: resultCell, subtitle: resultLine },
            { key: 'duration', label: 'Duration', line: 2, tone: 'tertiary', cell: tookOf },
            ...(!workflowHistory ? [{ key: 'conversation', label: 'Conversation', hideLabel: true, line: 2, when: r => !!r.session_id, cell: r => {
                if (!r.session_id) return '';
                const b = DT.link('Open the conversation'); b.setAttribute('data-on-click', 'job-run-session'); b.dataset.sessionId = r.session_id; return b;
            } }] : []),
        ],
    });
    table.el.classList.add('sched-runs-table'); return table.el;
}

const formatDuration = ms => fmtDuration(ms);

// ── CRUD operations ──────────────────────────────────────────────────────

export async function toggleScheduledJob(jobId) {
    try {
        await fetch(`/api/scheduled/jobs/${jobId}/toggle`, { method: 'POST' });
        await fetchJobs();
        if (selectedJobId === jobId) selectScheduledJob(jobId);
    } catch (e) {
        showToast('Failed to toggle job', true);
    }
}

export function deleteScheduledJob(jobId) {
    window.showConfirmModal('Delete Job', 'Delete this scheduled job and all its run history?', async () => {
        try {
            await fetch(`/api/scheduled/jobs/${jobId}`, { method: 'DELETE' });
            showToast('Job deleted');
            selectedJobId = null;
            showView("welcome-screen");
            await fetchJobs();
        } catch (e) {
            showToast('Failed to delete job', true);
        }
    });
}

// ── Init ─────────────────────────────────────────────────────────────────

function toggleJobMore(btn, open) {
    const menu = document.getElementById(btn.getAttribute('aria-controls'));
    if (!menu) return;
    const to = open === undefined ? menu.hidden : open;
    menu.hidden = !to;
    btn.setAttribute('aria-expanded', String(to));
}

/** Read the jobs again now (the 30 s poll's own call; the tests ask it too). */
export function refreshJobs() { return fetchJobs(); }

export function initScheduler() {
    document.addEventListener('job-saved', async e => { await fetchJobs(); selectScheduledJob(e.detail.id); }); // the job dialog saved one: the list is read again and the job opened
    // A click elsewhere and Escape close an open More (it is redrawn with the page, never kept)
    document.addEventListener('click', (e) => { for (const b of document.querySelectorAll('.sched-more-btn[aria-expanded="true"]')) if (!b.parentElement.contains(e.target)) toggleJobMore(b, false); });
    document.addEventListener('focusout', (e) => { const b = document.querySelector('.sched-more-btn[aria-expanded="true"]'); if (b && e.relatedTarget && !b.parentElement.contains(e.relatedTarget)) toggleJobMore(b, false); }); // Tab out of More closes it
    document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; const b = document.querySelector('.sched-more-btn[aria-expanded="true"]'); if (b) { toggleJobMore(b, false); b.focus(); e.stopPropagation(); } }, true);
    fetchJobs();
    // Refresh jobs every 30s
    pollEvery(refreshJobs, 30000, { whenHidden: true }); // job notifications
}

// The scheduled jobs' markup (#3645): data-on-* names, never code.
// Ids are checked (idOf, uuidOf) before use: a bad one does nothing. Deleting still asks first.
registerActions({
    'job-new': () => showJobModal(),
    'jobs-search-filter': el => filterJobs(el.value),
    'job-select': el => withId(el.dataset.jobId, selectScheduledJob),
    'job-back': () => { document.getElementById('scheduler-view')?.removeAttribute('data-phone-item'); const list = document.getElementById('scheduled-jobs-list'); const open = list && (list.querySelector('[aria-current="true"] .row-btn') || list.querySelector('.row-btn')); if (open) open.focus({ preventScroll: true }); }, // a phone: the job's page is under the list; back to the list with the open job focused (#7121)
    'job-edit': el => withId(el.dataset.jobId, editScheduledJob),
    'job-toggle': el => withId(el.dataset.jobId, toggleScheduledJob),
    'job-delete': el => withId(el.dataset.jobId, deleteScheduledJob),
    'job-more': el => toggleJobMore(el),
    'job-workflow': (el, event) => { event.preventDefault(); withId(el.dataset.workflowId, id => window.selectWorkflow(id)); },
    'job-run-session': (el, event) => { event.preventDefault(); const sid = uuidOf(el.dataset.sessionId); if (sid) window.selectHistorySession(sid); },
});
