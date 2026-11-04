/* Automations' runs (#9296, audit #9255 item 3): every run of every job and every workflow as one newest-first list, with an unread mark until a person opens it, for the Recent runs folder
 * (automations.js) and for the Inbox's Needs you rows (a failed run nobody has opened). The two reads already exist (GET /api/scheduled/runs/recent, GET /api/workflows/runs/recent): no route is
 * added. A job that runs a workflow makes two records (its own run and the workflow's run, which says so in its trigger context): the job's run is the one listed. What a person has opened is the server's (seen_at, #9315),
 * so every screen agrees; a run over when the column was added counts as opened (a long history is not a wall of dots). */
import { lastWords } from './job_words.js';
import { compactDuration } from './format.js';

const FRESH_MS = 30000, LIMIT = 100;
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
/** How long a finished run took, "2 s", "3 min", "1 h 05 min"; '' when it has not finished or has no times. */
export function tookWords(startedAt, finishedAt) {
    const a = ms(startedAt), b = ms(finishedAt);
    if (!a || !b || b < a) return '';
    return compactDuration((b - a) / 1000);
}

// ── The merged list (pure) ───────────────────────────────────────────────
const scheduledRunOf = r => { try { return Number(JSON.parse(r.trigger_context || '{}').scheduled_run_id) || 0; } catch { return 0; } };
const jobName = r => String(r.display_name || r.job_name || '').replace(/^__oneshot__$/, '') || `Job ${r.job_id}`;
/** The two reads as one list of items, newest first. A workflow run a job made (trigger "scheduled" with the job run's id in its context) is left out: the job's run stands for it. */
const jobItem = r => { const at = r.started_at || r.scheduled_at || r.created_at || ''; return { key: `job-${r.id}`, kind: 'job', runId: Number(r.id), parentId: Number(r.job_id), name: jobName(r), at, atMs: ms(at), finishedAt: r.finished_at || '', run: r, result: resultOf(r), over: isOver(r), failed: isFailed(r), sessionId: r.session_id || '' }; };
const workflowItem = r => { const at = r.started_at || r.created_at || ''; return { key: `wf-${r.id}`, kind: 'workflow', runId: Number(r.id), parentId: Number(r.workflow_id), name: String(r.workflow_name || `Workflow ${r.workflow_id}`), at, atMs: ms(at), finishedAt: r.finished_at || '', run: r, result: resultOf(r), over: isOver(r), failed: isFailed(r), sessionId: '' }; };
export function mergeRuns(jobRuns, workflowRuns) {
    const items = [];
    for (const r of jobRuns || []) items.push(jobItem(r));
    for (const r of workflowRuns || []) {
        if (r.trigger_type === 'scheduled' && scheduledRunOf(r)) continue;
        items.push(workflowItem(r));
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
// A run is opened once for every screen: the server keeps when (seen_at, set by POST .../seen) and the two reads carry it, so the phone, a second tab and the Hub agree.
/** Whether a finished run is unread: it has not been opened. A run still going is not (its dot comes when it ends). */
export function isUnread(item) { return item.over && !item.run.seen_at; }
export const unreadCount = () => runs.filter(isUnread).length;
/** The failed runs nobody has opened: the Inbox's Needs you rows. */
export const failedUnread = () => runs.filter(i => i.failed && isUnread(i));
/** The runs that ended well (or were stopped) and nobody has opened: not Needs you, so a line under its list says how many (#10515 point 2), and Recent runs lists them. */
export const finishedUnread = () => runs.filter(i => i.over && !i.failed && isUnread(i));
/** A person opened the run: it is read at once on this screen and told to the server (which tells every other); if the server cannot be told the run is unread again. */
const opened = new Map(); // key -> when, for runs opened here that a read answered before the server had been told: the read must not bring the dot back
export function markSeen(item) {
    if (item.run.seen_at) return Promise.resolve();
    const at = new Date().toISOString(); opened.set(item.key, at);
    for (const i of [item, ...runs.filter(r => r.key === item.key), ...page.items.filter(r => r.key === item.key)]) i.run.seen_at = at; // the row that was clicked may hold an item from before the last read: the list's own is read too
    fire();
    const path = item.kind === 'workflow' ? `/api/workflows/runs/${item.runId}/seen` : `/api/scheduled/runs/${item.runId}/seen`;
    return fetch(path, { method: 'POST' }).then(r => { if (!r.ok) throw new Error(String(r.status)); }).catch(() => { opened.delete(item.key); for (const i of [item, ...runs.filter(r => r.key === item.key), ...page.items.filter(r => r.key === item.key)]) delete i.run.seen_at; fire(); });
}
/** Where a run opens (the route handler's shape): a job's run on its job's page, a workflow's run on its run page. */
export const runRoute = item => (item.kind === 'workflow' ? { view: 'automations', folder: 'workflows', id: item.parentId, run: item.runId } : { view: 'automations', folder: 'jobs', id: item.parentId });
/** Why a run failed, on one line: the run's own words (a job's error, a workflow's reason and failed step), '' when it said none. */
export function failureWords(item) {
    const r = item.run || {};
    const why = String(r.failure_reason || r.error_msg || '').replace(/\s+/g, ' ').trim();
    return why.length > 140 ? `${why.slice(0, 139)}\u2026` : why;
}


// ── Recent runs as pages (#13183) ────────────────────────────────────────
// The Recent runs list asks the computer for a page: GET /api/automations/runs gives at most 50 runs, newest first, with the search and the Result filter applied there (before the cut) and the true total. Load more asks for the next
// page with the cursor the last one gave. The merged list above (at most 100) stays for the Inbox's Needs you rows and its unread badge: they read what is unread and failed, not a page of the history.
const PAGE_SIZE = 50, SEARCH_DEBOUNCE_MS = 250;
const page = { q: '', result: '', items: [], hasMore: false, cursor: '', total: 0, loading: false, loaded: false, failed: false, failedMore: false, stale: false, seq: 0, timer: 0 }; // stale: the rows drawn are for an earlier search or filter, a new first page is on its way (their cursor is gone); failedMore: the first page is current and the NEXT one did not come
/** The runs of the page(s) loaded for the search and Result filter now asked for, newest first. */
export const pagedRuns = () => page.items;
/** What the footer says: how many of how many, whether another page waits and whether one is on its way. */
export const pagedInfo = () => ({ total: page.total, hasMore: page.hasMore, loading: page.loading, loaded: page.loaded, failed: page.failed, failedMore: page.failedMore, stale: page.stale });
/** A string that changes when the paged list does, for the folder's redraw check. */
export const pagedSignature = () => JSON.stringify([page.q, page.result, page.loaded, page.loading, page.hasMore, page.total, page.failed, page.failedMore, page.stale, page.items.map(i => [i.key, i.run.status, isUnread(i)])]);
const RESULT_WORDS = ['passed', 'failed', 'running'];
function readPage(more) {
    const mySeq = ++page.seq;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (page.q) params.set('q', page.q);
    if (page.result) params.set('result', page.result);
    if (more && page.cursor) params.set('cursor', page.cursor);
    page.loading = true; page.failed = false; page.failedMore = false; fire();
    return fetch(`/api/automations/runs?${params}`).then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => {
        if (mySeq !== page.seq) return; // a newer search is on its way (or has come): this answer is for one nobody is looking at
        page.loading = false;
        if (!d || !Array.isArray(d.runs)) {
            page.failed = true;
            if (more) page.failedMore = true; // the rows drawn are this search's: they stay, with a way to ask for the next page again
            else { page.items = []; page.hasMore = false; page.cursor = ''; page.total = 0; page.loaded = false; page.stale = false; } // a first page that did not come: rows of an earlier search are not this one's results
            fire(); return;
        }
        const items = d.runs.map(r => (r.kind === 'workflow' ? workflowItem(r) : jobItem(r)));
        for (const i of items) if (opened.has(i.key)) { if (i.run.seen_at) opened.delete(i.key); else i.run.seen_at = opened.get(i.key); }
        const have = new Set(page.items.map(i => i.key));
        page.items = more ? [...page.items, ...items.filter(i => !have.has(i.key))] : items;
        page.hasMore = d.has_more === true && !!d.next_cursor; page.cursor = d.next_cursor || ''; page.total = Number(d.total) || 0; page.loaded = true; page.stale = false;
        fire();
    });
}
/** Make the paged list the one for this search and Result filter: nothing to do when it already is (loaded, on its way, waiting for the typing to pause, or failed: Retry asks again). A different search or filter drops the old cursor and any answer still on its way AT ONCE, also while the typing pauses; a new Result filter reads at once, a new search a moment after the last key. */
export function ensureRunsPage({ q = '', result = '' } = {}) {
    q = String(q || '').trim().slice(0, 200); result = RESULT_WORDS.includes(result) ? result : '';
    const same = page.q === q && page.result === result;
    if (same && (page.loaded || page.loading || page.timer || page.failed)) return;
    clearTimeout(page.timer); page.timer = 0;
    const changed = !same, wasLoaded = page.loaded, sameResult = page.result === result;
    if (changed) { page.seq++; page.cursor = ''; page.hasMore = false; page.loading = false; page.failed = false; page.failedMore = false; page.q = q; page.result = result; if (page.loaded) page.stale = true; }
    const read = () => { page.timer = 0; readPage(false); };
    if (changed && wasLoaded && sameResult) { page.timer = setTimeout(read, SEARCH_DEBOUNCE_MS); fire(); return; } // typing: wait for a pause
    read();
}
/** The next page of the same search and filter, appended. Nothing when there is none, one is already coming, or the rows drawn are an earlier search's. */
export function loadMoreRuns() { if (!page.hasMore || page.loading || !page.cursor || page.stale || page.timer) return null; return readPage(true); }
/** Ask again after a failure: the next page when the first came, else the first. */
export function retryRunsPage() { if (page.loading) return null; if (page.failedMore && page.cursor) return readPage(true); page.cursor = ''; return readPage(false); }
/** The list read again from the first page (a run ended, the person came back to it), for the search and filter it has. */
export function reloadRunsPage() { page.cursor = ''; return readPage(false); }
/** The first page read again when one is loaded (a run ended, Automations came back on screen): the page the person has is replaced by the newest 50 for the same search and filter. */
export function refreshRunsPage() { return page.loaded && !page.loading && !page.stale && !page.timer ? reloadRunsPage() : null; }

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
        for (const i of runs) if (opened.has(i.key)) { if (i.run.seen_at) opened.delete(i.key); else i.run.seen_at = opened.get(i.key); }
        if (page.items.length) { const seen = new Map(runs.filter(i => i.run.seen_at).map(i => [i.key, i.run.seen_at])); for (const i of page.items) if (!i.run.seen_at && seen.has(i.key)) i.run.seen_at = seen.get(i.key); } // a run opened on another screen: the page's copy of it is read too, with no read of its own (the page itself is read again only when the person comes back or a run ends)
        fire();
    }).finally(() => { pending = null; });
    return pending;
}
/** The first read of a page that shows runs (Automations, the Inbox): turns the refresh on. */
export const startRuns = () => refreshRuns(true);
