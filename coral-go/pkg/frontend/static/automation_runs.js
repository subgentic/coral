/* Automations' runs (#9296, audit #9255 item 3): every run of every job and every workflow as one newest-first list, with an unread mark until a person opens it, for the Recent runs folder
 * (automations.js) and for the Inbox's Needs you rows (a failed run nobody has opened). The two reads already exist (GET /api/scheduled/runs/recent, GET /api/workflows/runs/recent): no route is
 * added. A job that runs a workflow makes two records (its own run and the workflow's run, which says so in its trigger context): the job's run is the one listed. What a person has opened is kept in
 * this browser; runs from before this browser first looked are not unread (a long history is not a wall of dots). */
import { browserLocal } from './safe_storage.js';
import { lastWords } from './job_words.js';

const SEEN_KEY = 'coral-automation-runs-seen', FRESH_MS = 30000, LIMIT = 100, KEEP = 500;
let runs = [], pending = null, lastRead = 0, activated = false;
const listeners = new Set();
export const recentRuns = () => runs;
/** Called after a read that changed the list, and after a run was opened. Returns the way to stop. */
export const onRunsChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const fire = () => { for (const f of listeners) f(); };

// ── The words ────────────────────────────────────────────────────────────
/** A run's result in the words the chip says: Passed, Failed, Stopped, Running, Waiting. The whole phrase (a failure's reason, a restart) is the chip's tooltip. */
export function resultWords(run) {
    const full = String(lastWords(run) || '').replace(/^last run /, '');
    const first = full.split(/[\s(]/)[0];
    const word = { passed: 'Passed', failed: 'Failed', stopped: 'Stopped', running: 'Running', waiting: 'Waiting', completed: 'Completed' }[first] || (first ? first[0].toUpperCase() + first.slice(1) : '');
    return { word, full: full ? full[0].toUpperCase() + full.slice(1) : '' };
}
export const isFailed = run => !!run && (run.status === 'failed' || /^last run failed/.test(String(lastWords(run))));
const isOver = run => !!run && run.status !== 'running' && run.status !== 'pending';
const ms = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
/** How long a finished run took, "2 s", "3 min", "1 h 5 min"; '' when it has not finished or has no times. */
export function tookWords(startedAt, finishedAt) {
    const a = ms(startedAt), b = ms(finishedAt);
    if (!a || !b || b < a) return '';
    const s = Math.round((b - a) / 1000);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
}

// ── The merged list (pure) ───────────────────────────────────────────────
const scheduledRunOf = r => { try { return Number(JSON.parse(r.trigger_context || '{}').scheduled_run_id) || 0; } catch { return 0; } };
const jobName = r => String(r.display_name || r.job_name || '').replace(/^__oneshot__$/, '') || `Job ${r.job_id}`;
/** The two reads as one list of items, newest first. A workflow run a job made (trigger "scheduled" with the job run's id in its context) is left out: the job's run stands for it. */
export function mergeRuns(jobRuns, workflowRuns) {
    const items = [];
    for (const r of jobRuns || []) {
        const at = r.started_at || r.scheduled_at || r.created_at || '';
        items.push({ key: `job-${r.id}`, kind: 'job', runId: Number(r.id), parentId: Number(r.job_id), name: jobName(r), at, atMs: ms(at), finishedAt: r.finished_at || '', run: r, result: resultOf(r), over: isOver(r), failed: isFailed(r), sessionId: r.session_id || '' });
    }
    for (const r of workflowRuns || []) {
        if (r.trigger_type === 'scheduled' && scheduledRunOf(r)) continue;
        const at = r.started_at || r.created_at || '';
        items.push({ key: `wf-${r.id}`, kind: 'workflow', runId: Number(r.id), parentId: Number(r.workflow_id), name: String(r.workflow_name || `Workflow ${r.workflow_id}`), at, atMs: ms(at), finishedAt: r.finished_at || '', run: r, result: resultOf(r), over: isOver(r), failed: isFailed(r), sessionId: '' });
    }
    return items.sort((a, b) => b.atMs - a.atMs || b.runId - a.runId).slice(0, LIMIT);
}
/** The Result filter's four words (automation_filters.js resultOf) for a run, so the folder's filters match it like any other item. */
function resultOf(run) {
    if (run.status === 'running') return 'running';
    if (run.status === 'failed' || run.status === 'killed' || isFailed(run)) return 'failed';
    if (run.status === 'completed') return 'passed';
    return '';
}

// ── What a person has opened ─────────────────────────────────────────────
function loadSeen() {
    try { const v = JSON.parse(browserLocal.get(SEEN_KEY) || 'null'); if (v && typeof v.since === 'number' && Array.isArray(v.ids)) return v; } catch { /* a stored value that is not ours: start again */ }
    return null;
}
function saveSeen(v) { try { browserLocal.set(SEEN_KEY, JSON.stringify({ since: v.since, ids: v.ids.slice(-KEEP) })); } catch { /* storage may be blocked: the marks live for this page only */ } }
let seen = null;
const seenState = () => { if (!seen) { seen = loadSeen() || { since: Date.now(), ids: [] }; saveSeen(seen); } return seen; };
/** Whether a finished run is unread: it began after this browser first looked and has not been opened. A run still going is not (its dot comes when it ends). */
export function isUnread(item, state = seenState()) { return item.over && item.atMs > state.since && !state.ids.includes(item.key); }
export const unreadCount = () => runs.filter(i => isUnread(i)).length;
/** The failed runs nobody has opened: the Inbox's Needs you rows. */
export const failedUnread = () => runs.filter(i => i.failed && isUnread(i));
export function markSeen(item) {
    const s = seenState();
    if (s.ids.includes(item.key)) return;
    s.ids.push(item.key); saveSeen(s); fire();
}
/** Where a run opens (the route handler's shape): a job's run on its job's page, a workflow's run on its run page. */
export const runRoute = item => (item.kind === 'workflow' ? { view: 'automations', folder: 'workflows', id: item.parentId, run: item.runId } : { view: 'automations', folder: 'jobs', id: item.parentId });
/** Why a run failed, on one line: the run's own words (a job's error, a workflow's reason and failed step), '' when it said none. */
export function failureWords(item) {
    const r = item.run || {};
    const why = String(r.failure_reason || r.error_msg || '').replace(/\s+/g, ' ').trim();
    return why.length > 140 ? `${why.slice(0, 139)}\u2026` : why;
}

// ── The reads ────────────────────────────────────────────────────────────
/** Read both lists (at most once in 30 s unless forced; one read at a time). Called when Automations or the Inbox is shown, and by the Inbox's badge once it has been. */
export function refreshRuns(force = false) {
    if (force) activated = true;
    if (!activated) return null;
    if (pending) return pending;
    if (!force && Date.now() - lastRead < FRESH_MS) return null;
    lastRead = Date.now();
    const read = url => fetch(url).then(r => (r.ok ? r.json() : null)).then(d => (d && Array.isArray(d.runs) ? d.runs : null)).catch(() => null);
    pending = Promise.all([read(`/api/scheduled/runs/recent?limit=${LIMIT}`), read(`/api/workflows/runs/recent?limit=${LIMIT}`)]).then(([jobRuns, wfRuns]) => {
        if (jobRuns === null && wfRuns === null) return; // neither answered: keep what is drawn
        const old = key => runs.filter(i => i.kind === key).map(i => i.run); // one list that answered and one that did not: the other's runs stay as they were
        runs = mergeRuns(jobRuns ?? old('job'), wfRuns ?? old('workflow'));
        fire();
    }).finally(() => { pending = null; });
    return pending;
}
/** The first read of a page that shows runs (Automations, the Inbox): turns the refresh on. */
export const startRuns = () => refreshRuns(true);
