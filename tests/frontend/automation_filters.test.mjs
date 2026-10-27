// automation_filters.js: the Automations folders' filters: what an item must match, the order, the chips and the clean of a kept value (Goal #74).
import assert from 'node:assert/strict';

// The model keeps its choice in the browser store; node has none, so the store module is given a stand-in before the import.
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const AF = await import('../../coral-go/pkg/frontend/static/automation_filters.js');

const at = h => new Date(Date.UTC(2026, 9, 27, h)).toISOString();
const jobs = [
    { id: 1, name: 'nightly-build-job', enabled: 1, workflow_id: 7, next_fire_at: at(20), last_run: { status: 'failed', started_at: at(2) } },
    { id: 2, name: 'summarize-the-day', enabled: 1, agent_type: 'codex', prompt: 'Summarize what changed today.', next_fire_at: at(10), last_run: { status: 'completed', started_at: at(3) } },
    { id: 3, name: 'weekly-cleanup', enabled: 0, agent_type: 'claude', prompt: 'Tidy.', next_fire_at: null, last_run: null },
    { id: 4, name: 'watch-the-queue', enabled: 1, agent_type: 'claude', prompt: 'Look.', next_fire_at: at(12), last_run: { status: 'running', started_at: at(4) } },
    { id: 5, name: 'restart-victim', enabled: 1, agent_type: 'claude', prompt: 'x', next_fire_at: at(14), last_run: { status: 'completed', exit_reason: 'ended_while_coral_was_down', started_at: at(1) } },
];
const items = jobs.map(j => AF.jobItem(j, id => (id === 7 ? 'nightly-build' : '')));
const ids = f => items.filter(i => AF.matches(i, { ...AF.EMPTY, ...f })).map(i => i.id).join();

assert.deepEqual(items.map(i => i.result), ['failed', 'passed', 'never', 'running', ''], 'a run is passed, failed, running or never; one cut short by a restart is none of them');
assert.deepEqual(items.map(i => i.runs), ['workflow', 'prompt', 'prompt', 'prompt', 'prompt']);
assert.equal(ids({}), '1,2,3,4,5', 'no filter keeps every item');
assert.equal(ids({ q: 'SUMMARIZE' }), '2', 'the search is any case and covers the name');
assert.equal(ids({ q: 'nightly-build' }), '1', 'and the workflow a job runs');
assert.equal(ids({ q: 'changed today' }), '2', 'and the prompt');
assert.equal(ids({ state: 'active' }), '1,2,4,5');
assert.equal(ids({ state: 'paused' }), '3');
assert.equal(ids({ result: 'failed' }), '1');
assert.equal(ids({ result: 'never' }), '3');
assert.equal(ids({ result: 'running' }), '4');
assert.equal(ids({ runs: 'workflow' }), '1');
assert.equal(ids({ runs: 'prompt' }), '2,3,4,5');
assert.equal(ids({ agent: 'codex' }), '2');
assert.equal(ids({ agent: 'claude' }), '3,4,5', 'a job that runs a workflow has no agent of its own');
assert.equal(ids({ state: 'active', runs: 'prompt', result: 'passed' }), '2', 'filters narrow together');

assert.equal(AF.ordered(items, AF.EMPTY).map(i => i.id).join(), '2,4,5,1,3', 'by next run, a paused job last');
assert.equal(AF.ordered(items, { ...AF.EMPTY, sort: 'name' }).map(i => i.id).join(), '1,5,2,4,3', 'by name A to Z');
assert.equal(AF.ordered(items, { ...AF.EMPTY, sort: 'last' }).map(i => i.id).join(), '4,2,1,5,3', 'by last run, newest first, a job never run last');
assert.equal(AF.ordered(items, { ...AF.EMPTY, sort: 'nonsense' }).map(i => i.id).join(), '2,4,5,1,3', 'an unknown order is the default');
assert.equal(items[0].id, 1, 'the list the caller passed is not reordered');

assert.deepEqual(AF.clean({ state: 'other', result: 'passed', runs: 5, agent: 'gpt', sort: 'name', q: 'x'.repeat(300) }), { ...AF.EMPTY, result: 'passed', sort: 'name', q: 'x'.repeat(200) });
assert.deepEqual(AF.chips({ ...AF.EMPTY, q: 'x', state: 'paused', result: 'failed', runs: 'workflow', agent: 'agy' }).map(c => c.label), ['Search: x', 'Result: Failed', 'Runs: A workflow', 'Agent: Antigravity']);
assert.equal(AF.isFiltered({ ...AF.EMPTY, result: 'failed' }), true);
assert.equal(AF.isFiltered({ ...AF.EMPTY, sort: 'name' }), false, 'the order alone does not narrow');

// workflows are items too: the step types are the ones their steps have (no type is shell)
const wfs = [
    { id: 1, name: 'nightly-build', description: 'Build and test', enabled: 1, steps: [{ name: 'Install' }, { name: 'Test', type: 'shell' }], last_run: { status: 'failed', started_at: at(2) } },
    { id: 2, name: 'review-pass', description: '', enabled: 1, step_count: 3, steps: [{ type: 'agent' }, { type: 'shell' }, { type: 'agent' }], last_run: { status: 'completed', started_at: at(5) } },
    { id: 3, name: 'old-flow', enabled: 0, steps: [], last_run: null },
];
const wi = wfs.map((w, i) => AF.workflowItem(w, i));
const wids = f => wi.filter(i => AF.matches(i, { ...AF.EMPTY, ...f })).map(i => i.id).join();
assert.deepEqual(wi.map(i => [i.stepCount, i.stepTypes.join('+'), i.usedBy, i.result]), [[2, 'shell', 0, 'failed'], [3, 'agent+shell', 1, 'passed'], [0, '', 2, 'never']]);
assert.equal(wids({ step: 'agent' }), '2', 'Step type: a workflow with an agent step');
assert.equal(wids({ step: 'shell' }), '1,2', 'a step with no type is a shell step');
assert.equal(wids({ state: 'paused' }), '3');
assert.equal(wids({ q: 'build and test' }), '1', 'the search covers the description');
assert.equal(AF.ordered(wi, AF.EMPTY).map(i => i.id).join(), '1,3,2', 'workflows have no next run: by name');
assert.equal(AF.ordered(wi, { ...AF.EMPTY, sort: 'last' }).map(i => i.id).join(), '1,2,3'.split(',').sort((a, b) => wi.find(i => i.id == b).last - wi.find(i => i.id == a).last || a - b).join(), 'by last run, newest first');
assert.deepEqual(AF.chips({ ...AF.EMPTY, step: 'agent' }).map(c => c.label), ['Step type: Agent']);

AF.saveFilters('jobs', { ...AF.EMPTY, result: 'failed', q: 'gone' });
assert.deepEqual(AF.loadFilters('jobs'), { ...AF.EMPTY, result: 'failed' }, 'what is chosen is kept for the folder; the search words are not');
assert.deepEqual(AF.loadFilters('workflows'), AF.EMPTY, 'another folder has its own');
console.log('automation_filters: ok');
