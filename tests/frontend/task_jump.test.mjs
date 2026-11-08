// Jump to agent (#14565): who a task's page can open. jumpTarget is pure: the task, the live list and the board in, a kind out.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { jumpTarget } = await import(pathToFileURL(path.join(here, '../../coral-go/pkg/frontend/static/task_jump.js')).href);
const dev = { name: 'dev-1', display_name: 'Frontend Dev', session_id: 's-dev', server: 'local' };
const qa = { name: 'qa-1', display_name: 'QA Engineer', session_id: 's-qa', server: 'm1' }; // a remote agent through the Hub
const live = [dev, qa];
const t = (over) => ({ status: 'in_progress', assigned_to: 'Frontend Dev', ...over });

const run = (task, list = live) => { const j = jumpTarget(task, list); return j && { kind: j.kind, name: j.name, state: j.state, session: j.session }; };

assert.deepEqual(run(t({})), { kind: 'agent', name: 'Frontend Dev', state: 'running', session: dev }, 'the assignee that runs');
assert.equal(run(t({ assigned_to: 'dev-1' })).session, dev, 'by the session name too');
assert.equal(run(t({ assigned_to: 'gone', session_id: 's-dev' })).session, dev, 'the task\'s own session wins');
assert.equal(run(t({ assigned_to: 'QA Engineer' })).session.server, 'm1', 'a remote agent keeps its server for the jump');
// the Operator: always shows, always jumps; the state is words, never a hidden button
assert.deepEqual(run(t({ assigned_to: 'Nobody Home' })), { kind: 'agent', name: 'Nobody Home', state: 'ended', session: null }, 'in progress, not running: still a target');
assert.deepEqual(run(t({ status: 'pending', assigned_to: 'Nobody Home' })), { kind: 'agent', name: 'Nobody Home', state: 'ended', session: null }, 'queued with an assignee: a target');
for (const status of ['completed', 'skipped', 'cancelled']) assert.equal(run(t({ status })).kind, 'agent', `${status}: still a target`);
assert.equal(run(t({ status: 'completed', assigned_to: '', worked_by: 'Frontend Dev' })).name, 'Frontend Dev', 'a finished task names who did it');
assert.equal(run(t({ assigned_to: '' })), null, 'no assignee: no button');
assert.equal(run(null), null);
assert.equal(run(t({}), [{ ...dev, sleeping: true }]).state, 'asleep', 'a sleeping agent is in the list: asleep');
assert.equal(run(t({}), [{ ...dev, archived: true }]).state, 'ended', 'an archived agent is not running');

// a task in review: the reviewer, not the author
const review = (reviewers, over) => t({ review_requested: true, reviewers, ...over });
assert.deepEqual(run(review([{ name: 'QA Engineer' }])), { kind: 'reviewer', name: 'QA Engineer', state: 'running', session: qa }, 'review: the reviewer, though the author runs too');
assert.equal(run(review(['Nobody', 'QA Engineer'])).name, 'QA Engineer', 'the first reviewer that runs; names as plain strings work');
assert.deepEqual(run(review([{ name: 'Nobody' }])), { kind: 'reviewer', name: 'Nobody', state: 'ended', session: null }, 'review: the reviewer is not running: still the reviewer');
assert.equal(run(review([])).kind, 'agent', 'review with no reviewer picked yet: the author');
assert.equal(run({ status: 'review_pending', reviewers: [{ name: 'QA Engineer' }] }).kind, 'reviewer', 'review_pending alone says it is in review');
console.log('task_jump: ok');
