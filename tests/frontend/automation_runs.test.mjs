// automation_runs.js: every run of every job and workflow as one newest-first list with an unread mark (#9296): the merge (a workflow run a job made is the job's run, listed once), the words of a
// result and of how long it took, and what counts as unread (finished, after this browser first looked, not opened), kept in the browser.
import assert from 'node:assert/strict';

globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const URL_OF = '../../coral-go/pkg/frontend/static/automation_runs.js';
const AR = await import(URL_OF);

const at = min => new Date(Date.UTC(2026, 9, 27, 10, min)).toISOString();
const jobRuns = [
    { id: 5, job_id: 1, job_name: 'nightly-build-job', status: 'failed', started_at: at(30), finished_at: at(31), error_msg: 'step 2 failed' },
    { id: 4, job_id: 2, job_name: 'summarize-the-day', status: 'completed', started_at: at(20), finished_at: at(22), session_id: 'sess-1' },
    { id: 3, job_id: 2, job_name: 'summarize-the-day', status: 'running', started_at: at(40) },
];
const wfRuns = [
    { id: 9, workflow_id: 7, workflow_name: 'nightly-build', status: 'failed', trigger_type: 'scheduled', trigger_context: '{"scheduled_job_id":1,"scheduled_run_id":5}', started_at: at(30), finished_at: at(31) },
    { id: 8, workflow_id: 7, workflow_name: 'nightly-build', status: 'completed', trigger_type: 'ui', started_at: at(10), finished_at: at(70) },
    { id: 7, workflow_id: 8, workflow_name: 'review-pass', status: 'completed', trigger_type: 'scheduled', trigger_context: 'not json', started_at: at(5), finished_at: at(5) },
];
const items = AR.mergeRuns(jobRuns, wfRuns);
assert.deepEqual(items.map(i => i.key), ['job-3', 'job-5', 'job-4', 'wf-8', 'wf-7'], 'newest first; the workflow run a job made (its context names the job run) is left out, one with no readable context stays');
assert.deepEqual(items.map(i => i.result), ['running', 'failed', 'passed', 'passed', 'passed']);
assert.deepEqual(items.map(i => i.over), [false, true, true, true, true]);
assert.equal(items[2].sessionId, 'sess-1');
assert.equal(AR.mergeRuns(null, null).length, 0, 'a list that did not answer is nothing');
assert.equal(AR.mergeRuns(Array.from({ length: 150 }, (_, i) => ({ id: i + 1, job_id: 1, status: 'completed', started_at: at(i) })), []).length, 100, 'the newest hundred');

assert.deepEqual(AR.resultWords({ status: 'completed' }), { word: 'Passed', full: 'Passed' });
assert.equal(AR.resultWords({ status: 'failed' }).word, 'Failed');
assert.equal(AR.resultWords({ status: 'killed' }).word, 'Stopped');
assert.equal(AR.resultWords({ status: 'running' }).word, 'Running');
assert.equal(AR.resultWords({ status: 'pending' }).word, 'Waiting');
assert.equal(AR.isFailed({ status: 'failed' }), true);
assert.equal(AR.isFailed({ status: 'completed' }), false);
assert.equal(AR.isFailed(null), false);

assert.equal(AR.tookWords(at(0), at(0)), '0 s');
assert.equal(AR.tookWords(at(0), new Date(Date.UTC(2026, 9, 27, 10, 0, 42)).toISOString()), '42 s');
assert.equal(AR.tookWords(at(0), at(3)), '3 min');
assert.equal(AR.tookWords(at(0), at(65)), '1 h 05 min');
assert.equal(AR.tookWords(at(0), at(60)), '1 h 00 min');
assert.equal(AR.tookWords(at(0), ''), '', 'not finished: no time');
assert.equal(AR.tookWords(at(5), at(0)), '', 'a finish before the start is no time');

// unread: finished and not opened (the server's seen_at)
assert.deepEqual(items.map(i => AR.isUnread(i)), [false, true, true, true, true], 'a run still going is not unread (its dot comes when it ends)');
assert.equal(AR.isUnread({ over: true, run: { seen_at: '2026-10-27T10:00:00Z' } }), false, 'an opened run is not');

// the reads carry seen_at, opening a run tells the server once, and a read that raced the open does not bring the dot back
const calls = [];
let jobList = jobRuns.map(r => ({ ...r })), wfList = wfRuns.map(r => ({ ...r })), postStatus = 200;
globalThis.fetch = async (url, o = {}) => {
    calls.push(`${o.method || 'GET'} ${url}`);
    if (o.method === 'POST') return new Response('{}', { status: postStatus });
    return new Response(JSON.stringify({ runs: /scheduled/.test(url) ? jobList : wfList }), { status: 200 });
};
let told = 0; const off = AR.onRunsChanged(() => told++);
await AR.refreshRuns(true);
assert.deepEqual(AR.recentRuns().map(i => AR.isUnread(i)), [false, true, true, true, true]);
assert.deepEqual(AR.failedUnread().map(i => i.key), ['job-5'], 'the failed unopened run is a Needs you row (the workflow run it made is the job\'s)');
assert.equal(AR.unreadCount(), 4);
const failed = AR.recentRuns().find(i => i.key === 'job-5');
told = 0;
await AR.markSeen(failed);
assert.ok(calls.includes('POST /api/scheduled/runs/5/seen'), 'the server is told: ' + calls.join());
assert.equal(AR.isUnread(failed), false);
assert.ok(told >= 1);
await AR.markSeen(failed);
assert.equal(calls.filter(c => c.startsWith('POST')).length, 1, 'a run already opened is not told again');
// a read that answered before the server heard (no seen_at in it) keeps the run read here
await AR.refreshRuns(true);
assert.equal(AR.unreadCount(), 3, 'the stale read did not bring the dot back');
jobList = jobList.map(r => (r.id === 5 ? { ...r, seen_at: '2026-10-27T10:05:00Z' } : r));
await AR.refreshRuns(true);
assert.equal(AR.unreadCount(), 3, 'and once the server says so, it is its time');
// a workflow run goes to the workflow route; a failure to tell the server makes the run unread again
const wf = AR.recentRuns().find(i => i.key === 'wf-8'); postStatus = 500;
await AR.markSeen(wf);
assert.ok(calls.includes('POST /api/workflows/runs/8/seen'));
assert.equal(AR.isUnread(wf), true, 'the server could not be told: unread again');
// another screen opened it meanwhile: the next read has it
wfList = wfList.map(r => (r.id === 8 ? { ...r, seen_at: '2026-10-27T10:06:00Z' } : r));
await AR.refreshRuns(true);
assert.equal(AR.recentRuns().find(i => i.key === 'wf-8').run.seen_at, '2026-10-27T10:06:00Z', 'what another screen opened is read from the server');
off();
assert.deepEqual(AR.runRoute(items[1]), { view: 'automations', folder: 'jobs', id: 1 });
assert.deepEqual(AR.runRoute(items[3]), { view: 'automations', folder: 'workflows', id: 7, run: 8 });
assert.equal(AR.failureWords({ run: { error_msg: 'step 2 (Test) failed:\n exit code 3' } }), 'step 2 (Test) failed: exit code 3');
assert.equal(AR.failureWords({ run: { failure_reason: 'x'.repeat(200) } }).length, 140);
assert.equal(AR.failureWords({ run: {} }), '');
console.log('automation_runs: ok');
