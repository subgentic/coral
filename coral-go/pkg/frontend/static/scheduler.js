/* Scheduler: scheduled jobs sidebar list, job detail view, and CRUD operations */

import { isPhoneLayout } from './phone_layout.js';
import { state } from './state.js';
import { escapeHtml, escapeAttr, showToast, showView, setRowCurrent } from './utils.js';
import { registerActions, withId, uuidOf } from './actions.js';
import { pollEvery } from './overload.js';
import { showJobModal, editScheduledJob } from './job_form.js';
import { formatDuration } from './format.js';
import { runFailure } from './run_failure.js';
import { cronWords, atWords, awayWords, whenWords, resultWords, reasonWords, lastWords, limitWords, exitNote, resultLine } from './job_words.js';
import { foldWayBack } from './sidebar_groups.js';
import { note } from './nav.js';
import { importOnce } from './import_once.js';
import * as DT from './data_table.js';

let scheduledJobs = [];
let selectedJobId = null;
const jobsListeners = new Set();
/** The jobs as the last read left them (the folders of Automations draw their rows from it) and a way to be told when a read changed them. */
export const jobList = () => scheduledJobs;
export const onJobsChanged = fn => { jobsListeners.add(fn); return () => jobsListeners.delete(fn); };
export const openJobId = () => selectedJobId;

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
        for (const f of jobsListeners) f();
        announceFailedRuns(before);
    } catch (e) {
        console.error('Failed to fetch scheduled jobs:', e);
    }
}

const RUNS_PAGE = 20; // runs read at a time: the page opens with the newest and the footer reads the older ones (#8089: it showed the newest 20 and said nothing of the rest)
let runsPage = null; // the runs on screen for the open job: { jobId, workflowId, workflowHistory, rows, total, busy }

async function fetchJobRuns(jobId) {
    try {
        const resp = await fetch(`/api/scheduled/jobs/${jobId}/runs?limit=${RUNS_PAGE}`);
        const data = await resp.json();
        return { runs: data.runs || [], total: data.total };
    } catch (e) {
        console.error('Failed to fetch runs:', e);
        return { runs: [], total: 0 };
    }
}

// ── Words a job's row and page share ─────────────────────────────────────

export const scheduleOf = job => cronWords(job.cron_expr) + (job.timezone ? ` (${job.timezone})` : '');
export const nextOf = job => !job.enabled ? 'Paused' : job.next_fire_at ? awayWords(job.next_fire_at) : 'Not scheduled';

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

    const job = scheduledJobs.find(j => j.id === jobId);
    if (!job) return;

    // Hide other views, show scheduler view
    showView("scheduler-view");
    note({ view: 'automations', folder: 'jobs', id: jobId }); // the address follows the job on screen (Goal #74), whoever opened it

    // Deselect live/history sessions
    state.currentSession = null;
    document.querySelectorAll('.session-list-item.active').forEach(el => setRowCurrent(el, false));

    const [jobRuns, , workflowPage] = await Promise.all([fetchJobRuns(jobId), job.workflow_id ? loadWorkflowsById() : null,
        job.workflow_id ? fetch(`/api/workflows/${Number(job.workflow_id)}/runs`).then(r => { if (!r.ok) throw new Error('Unable to load workflow runs'); return r.json(); }).then(data => ({ runs: data.runs || [], total: data.total })).catch(() => null) : null]);
    if (selectedJobId !== jobId) return;
    renderJobDetail(job, jobRuns.runs, workflowPage && workflowPage.runs, jobRuns.total, workflowPage && workflowPage.total);
    if (isPhoneLayout()) { document.getElementById('scheduler-view')?.setAttribute('data-phone-item', ''); document.getElementById('scheduler-detail')?.scrollIntoView({ block: 'start' }); } // a phone shows the job's page as its own screen (#7443); the list is the screen before it (#6139)
}

function renderJobDetail(job, runs, workflowRuns, runsTotal, workflowRunsTotal) {
    const container = document.getElementById('scheduler-detail');
    if (!container) return;

    const isWorkflow = !!job.workflow_id;
    const wf = isWorkflow && workflowsById ? workflowsById.get(Number(job.workflow_id)) : null;
    const wfName = wf ? wf.name : `workflow ${job.workflow_id}`;
    const doesHtml = isWorkflow
        ? `Workflow <a href="#" data-on-click="job-workflow" data-workflow-id="${Number(job.workflow_id)}" class="sched-link">${escapeHtml(wfName)}</a>${wf && Array.isArray(wf.steps) ? ` (${wf.steps.length} step${wf.steps.length === 1 ? '' : 's'})` : ''}`
        : `${escapeHtml(AGENT_NAMES[job.agent_type] || job.agent_type || 'Agent')} agent${job.repo_path ? ` in <span class="sched-path">${escapeHtml(job.repo_path)}</span>` : ''}`;

    const workflowHistory = !!(isWorkflow && workflowRuns?.length);
    const history = workflowHistory ? workflowRuns : runs;
    runsPage = { jobId: job.id, workflowId: workflowHistory ? Number(job.workflow_id) : 0, workflowHistory, rows: history, total: workflowHistory ? workflowRunsTotal : runsTotal, busy: false };

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
    const status = [job.enabled ? 'Active' : (job.paused_reason ? 'Paused: failing' : 'Paused'), lastWords(job.last_run), job.enabled && job.next_fire_at ? `next ${awayWords(job.next_fire_at)}` : ''].filter(Boolean).join(' \u00b7 ');
    // A short prompt is shown; a long one is folded (it would push the runs off the page)
    const longPrompt = (job.prompt || '').length > 600 || (job.prompt || '').split('\n').length > 10;
    const promptHtml = !isWorkflow && job.prompt
        ? (longPrompt
            ? `<details class="disclosure sched-prompt-section"><summary>Prompt</summary><pre class="sched-prompt">${escapeHtml(job.prompt)}</pre></details>`
            : `<section class="sched-prompt-section sched-prompt-shown"><h3>Prompt</h3><pre class="sched-prompt">${escapeHtml(job.prompt)}</pre></section>`)
        : '';
    container.innerHTML = `
        <button type="button" class="back-link" data-on-click="automations-back" data-folder="jobs">&larr; Jobs</button>
        <button type="button" class="back-link sched-back" data-on-click="automations-back" data-folder="jobs">&larr; Jobs</button>
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
            <h3>${workflowHistory ? 'Workflow runs' : 'Runs'}</h3>
            <div id="sched-run-history"></div>
        </div>
        <div class="item-bar sched-actions">
            <div class="sched-more">
                <button class="btn btn-small sched-more-btn" type="button" data-on-click="job-more" aria-expanded="false" aria-controls="${escapeAttr(moreId)}" aria-label="More for ${escapeAttr(job.name)}">More</button>
                <div class="sched-more-menu" id="${escapeAttr(moreId)}" hidden>
                    ${job.enabled ? `<button class="btn btn-small" type="button" data-on-click="job-toggle" data-job-id="${Number(job.id)}" aria-label="Pause ${escapeAttr(job.name)}">Pause</button>` : ''}
                    <button class="btn btn-small btn-warning sched-delete" type="button" data-on-click="job-delete" data-job-id="${Number(job.id)}" aria-label="Delete ${escapeAttr(job.name)}">Delete</button>
                </div>
            </div>
            <button class="btn btn-small" data-on-click="job-edit" data-job-id="${Number(job.id)}">Edit</button>
            ${job.enabled
                ? `<button class="btn btn-small btn-primary" data-on-click="job-run-now" data-job-id="${Number(job.id)}">Run now</button>`
                : `<button class="btn btn-small" data-on-click="job-run-now" data-job-id="${Number(job.id)}">Run now</button>
            <button class="btn btn-small btn-primary" data-on-click="job-toggle" data-job-id="${Number(job.id)}">Enable</button>`}
        </div>
    `;
    container.querySelector('#sched-run-history').append(renderRunsTable(runsPage));
    foldWayBack(container, '.sched-back', '.sched-header');
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Antigravity', pi: 'Pi' };

function resultCell(r) {
    const unseen = r.status === 'completed' && r.exit_reason === 'ended_while_coral_was_down';
    const cls = unseen ? '' : r.status === 'completed' ? 'goal-state-task-done' : r.status === 'failed' || r.status === 'killed' ? 'team-state-bad' : r.status === 'running' ? 'goal-state-task-active' : '';
    const cell = DT.el('span'), chip = DT.chip(r.status === 'failed' ? 'Failed' : resultWords(r), cls); chip.classList.add('sched-status'); cell.append(chip);
    const failure = runFailure(r);
    const reason = r.status === 'failed' ? reasonWords(r) || exitNote(r) || (failure ? `${failure.text}. ${failure.hint}` : '') : resultLine(r);
    if (reason) { chip.title = reason; cell.append(DT.el('span', 'sr-only dt-run-reason', ` ${reason}`)); } // one line a row (Goal #79): the reason is the chip's tooltip and said to assistive technology, not a second line
    return cell;
}
const tookOf = (r) => (r.started_at && r.finished_at ? formatDuration(new Date(r.finished_at) - new Date(r.started_at)) : r.started_at ? 'running...' : '-');

// Both job kinds share the table; workflow runs open their run and agent runs link to their conversation.
function renderRunsTable(page) {
    const { rows: runs, workflowHistory } = page;
    const open = r => withId(r.id, id => window.selectWorkflowRun(id));
    const table = DT.dataTable({ label: 'Job runs', rows: runs, rowKey: r => r.id, bare: true, sortBar: false, oneLine: true,
        footer: runs.length < page.total ? { text: `Showing the newest ${runs.length} of ${page.total} runs`, more: { label: 'Show older runs', busy: page.busy, run: () => readOlderRuns(page) } } : undefined,
        open: workflowHistory ? open : undefined, empty: { line: 'No runs yet.' },
        columns: [
            { key: 'started', label: 'Started', primary: true, width: '9.5rem', cell: r => {
                const time = DT.timeCell(workflowHistory ? r.started_at || r.created_at : r.scheduled_at || r.started_at);
                if (!workflowHistory) return time;
                const b = DT.primaryButton(time.textContent, `Open run #${r.id}`); b.title = time.title; b.addEventListener('click', () => open(r)); return b;
            } },
            { key: 'result', label: 'Result', width: 'grow', cell: resultCell },
            { key: 'duration', label: 'Duration', width: '6rem', dropAt: 36, tone: 'tertiary', cell: tookOf },
            ...(!workflowHistory ? [{ key: 'conversation', label: 'Conversation', hideLabel: true, width: '5rem', when: r => !!r.session_id, cell: r => {
                if (!r.session_id) return '';
                // short, so the Result keeps its room at 390 (Started 9.5 rem, Chat 5 rem)
                const b = DT.link('Chat'); b.setAttribute('aria-label', 'Open the conversation'); b.setAttribute('data-on-click', 'job-run-session'); b.dataset.sessionId = r.session_id; return b;
            } }] : []),
        ],
    });
    table.el.classList.add('sched-runs-table'); return table.el;
}

/** The next RUNS_PAGE older runs of the job on screen, added under the ones shown. */
async function readOlderRuns(page) {
    if (runsPage !== page || page.busy) return;
    page.busy = true; redrawRuns(page);
    try {
        const url = page.workflowId ? `/api/workflows/${page.workflowId}/runs` : `/api/scheduled/jobs/${page.jobId}/runs`;
        const resp = await fetch(`${url}?limit=${RUNS_PAGE}&offset=${page.rows.length}`);
        if (!resp.ok) throw new Error('not read');
        const data = await resp.json();
        const have = new Set(page.rows.map(r => r.id));
        page.rows = page.rows.concat((data.runs || []).filter(r => !have.has(r.id)));
        if (Number.isFinite(data.total)) page.total = data.total;
        if (!(data.runs || []).length) page.total = page.rows.length; // nothing older came: stop offering more
    } catch { showToast('The older runs could not be read', true); }
    page.busy = false; redrawRuns(page);
}

function redrawRuns(page) {
    const host = document.getElementById('sched-run-history');
    if (host && runsPage === page) host.replaceChildren(renderRunsTable(page));
}


// ── CRUD operations ──────────────────────────────────────────────────────

async function toggleScheduledJob(jobId) {
    try {
        await fetch(`/api/scheduled/jobs/${jobId}/toggle`, { method: 'POST' });
        await fetchJobs();
        if (selectedJobId === jobId) selectScheduledJob(jobId);
    } catch (e) {
        showToast('Failed to toggle job', true);
    }
}

/** Run now: the job's workflow or prompt runs once, recorded as the job's run (#9293); the page shows the new run under the job. */
async function runScheduledJobNow(jobId, btn) {
    if (btn) btn.disabled = true;
    try {
        const resp = await fetch(`/api/scheduled/jobs/${jobId}/run`, { method: 'POST' });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(resp.status === 409 ? 'This job is already running' : (err.error || err.message || 'Could not start the run'), true);
            if (btn) btn.disabled = false;
            return;
        }
        await fetchJobs();
        if (selectedJobId === jobId) selectScheduledJob(jobId);
    } catch (e) {
        showToast('Could not start the run', true);
        if (btn) btn.disabled = false;
    }
}

function deleteScheduledJob(jobId) {
    window.showConfirmModal('Delete Job', 'Delete this scheduled job and all its run history?', async () => {
        try {
            await fetch(`/api/scheduled/jobs/${jobId}`, { method: 'DELETE' });
            showToast('Job deleted');
            selectedJobId = null;
            await fetchJobs();
            (await importOnce('./automations.js')).backToFolder('jobs');
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
    'job-edit': el => withId(el.dataset.jobId, editScheduledJob),
    'job-toggle': el => withId(el.dataset.jobId, toggleScheduledJob),
    'job-run-now': el => withId(el.dataset.jobId, id => runScheduledJobNow(id, el)),
    'job-delete': el => withId(el.dataset.jobId, deleteScheduledJob),
    'job-more': el => toggleJobMore(el),
    'job-workflow': (el, event) => { event.preventDefault(); withId(el.dataset.workflowId, id => window.selectWorkflow(id)); },
    'job-run-session': (el, event) => { event.preventDefault(); const sid = uuidOf(el.dataset.sessionId); if (sid) window.selectHistorySession(sid); },
});
