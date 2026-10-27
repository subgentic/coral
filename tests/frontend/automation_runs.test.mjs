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
assert.equal(AR.tookWords(at(0), at(65)), '1 h 5 min');
assert.equal(AR.tookWords(at(0), at(60)), '1 h');
assert.equal(AR.tookWords(at(0), ''), '', 'not finished: no time');
assert.equal(AR.tookWords(at(5), at(0)), '', 'a finish before the start is no time');

// unread: finished, began after the baseline, not opened
const base = { since: Date.parse(at(15)), ids: [] };
assert.deepEqual(items.map(i => AR.isUnread(i, base)), [false, true, true, false, false], 'a run still going is not unread (its dot comes when it ends); runs from before the baseline are not');
assert.equal(AR.isUnread(items[1], { ...base, ids: ['job-5'] }), false, 'an opened run is not');
// what was opened is kept in the browser, and the baseline is set once, the first time this browser looks
let AR2 = await import(`${URL_OF}?first`);
const fresh = { key: 'job-99', over: true, atMs: Date.now() + 60000 };
assert.equal(AR2.isUnread(fresh), true, 'a run that began after the first look is unread');
const stored = JSON.parse(localStorage.getItem('coral-automation-runs-seen'));
assert.ok(Math.abs(stored.since - Date.now()) < 5000 && stored.ids.length === 0, 'the baseline is the first look');
let told = 0; const off = AR2.onRunsChanged(() => told++);
AR2.markSeen(fresh); AR2.markSeen(fresh);
assert.equal(told, 1, 'opening a run tells the listeners once');
off();
AR2 = await import(`${URL_OF}?reloaded`); // a new page: the module starts again and reads what was kept
assert.equal(AR2.isUnread(fresh), false, 'a reloaded page remembers it was opened');
assert.deepEqual(JSON.parse(localStorage.getItem('coral-automation-runs-seen')).ids, ['job-99']);
assert.deepEqual(AR.runRoute(items[1]), { view: 'automations', folder: 'jobs', id: 1 });
assert.deepEqual(AR.runRoute(items[3]), { view: 'automations', folder: 'workflows', id: 7, run: 8 });
assert.equal(AR.failureWords({ run: { error_msg: 'step 2 (Test) failed:\n exit code 3' } }), 'step 2 (Test) failed: exit code 3');
assert.equal(AR.failureWords({ run: { failure_reason: 'x'.repeat(200) } }).length, 140);
assert.equal(AR.failureWords({ run: {} }), '');
console.log('automation_runs: ok');
