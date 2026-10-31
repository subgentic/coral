// What waits on a Needs you item (#11442): from a team's open tasks, the tasks whose blocked_by lists the item's task (a review) or the agent's in-progress tasks (an agent waiting on you), said as one short phrase,
// weighed so blockers sort first. A failed task query says nothing. Pure functions and a stubbed fetch.
//   node inbox_blockers.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const B = await importUi('inbox_blockers');

const t = (id, title, o = {}) => ({ id, title, status: 'pending', priority: 'medium', blocked_by: [], goal_id: 0, assigned_to: '', ...o });
const dep = (task_id, o = {}) => ({ task_id, board_id: 'b', satisfied: false, ...o });
const TASKS = [
    t(1, 'Review the checkout mockup', { status: 'review_pending', goal_id: 7 }),
    t(2, 'Tag v2.0.10', { blocked_by: [dep(1)], priority: 'high', goal_id: 7 }),
    t(3, 'Write the notes', { blocked_by: [dep(1)] }),
    t(4, 'Already unblocked', { blocked_by: [dep(1, { satisfied: true })] }),
    t(5, 'Waits on another board', { blocked_by: [dep(1, { board_id: 'other' })] }),
    t(10, 'Frontend work', { status: 'in_progress', assigned_to: 'Frontend Dev', goal_id: 8 }),
    t(11, 'Needs the frontend', { blocked_by: [dep(10)], goal_id: 8 }),
    t(12, 'Also needs it', { blocked_by: [dep(10)] }),
    t(20, 'Lonely goal task', { status: 'review_pending', goal_id: 9 }),
];

// the tasks that wait on one: unsatisfied, same board, not itself
assert.deepEqual(B.dependentsOf(TASKS, 'b', 1).map(x => x.id), [2, 3], 'a satisfied dependency, another board\'s task and the task itself do not count');
assert.deepEqual(B.dependentsOf(TASKS, 'b', 99), [], 'nothing waits on a task nobody lists');

// a review: its task's dependents; the highest priority first; "closes goal" when its task is the last open one of its goal
let r = B.reviewInfo(TASKS, { board: 'b', taskId: 1, goalId: 7, goalTitle: 'Checkout' });
assert.equal(r.count, 2); assert.equal(r.high, true); assert.equal(r.first, 'Tag v2.0.10');
assert.equal(B.phraseOf(r), 'High priority: 2 tasks wait on this');
r = B.reviewInfo(TASKS, { board: 'b', taskId: 20, goalId: 9, goalTitle: 'Solo' });
assert.equal(r.count, 0); assert.equal(r.closes, 'Solo'); assert.equal(B.phraseOf(r), 'Closes goal “Solo”', 'the last open task of a goal says so when nothing waits on it either');
const one = B.reviewInfo([t(1, 'Tag batch-88', { status: 'review_pending' }), t(2, 'Tag batch-88 release', { blocked_by: [dep(1)] })], { board: 'b', taskId: 1, goalId: 0 });
assert.equal(B.phraseOf(one), '“Tag batch-88 release” waits on this', 'one waiter is named');
assert.equal(B.reviewInfo(TASKS, { board: 'b', taskId: 3, goalId: 0 }), null, 'nothing waits on it and it closes no goal: no phrase');
assert.equal(B.reviewInfo(TASKS, { board: 'b', taskId: 0, goalId: 0 }), null, 'a review with no task');

// an agent waiting on you: its in-progress tasks and what waits on them
let a = B.agentInfo(TASKS, { board: 'b', names: ['frontend dev'] });
assert.equal(a.count, 3, 'its task and the two that wait on it'); assert.equal(B.phraseOf(a), '3 tasks wait on this');
assert.equal(B.agentInfo(TASKS, { board: 'b', names: ['Backend Dev'] }), null, 'an agent with no task in progress says nothing');
assert.equal(B.agentInfo(TASKS, { board: 'b', names: [] }), null);

// the short form for a one-line phone row
assert.equal(B.shortPhraseOf(r), 'Closes a goal'); assert.equal(B.shortPhraseOf(a), 'Blocks 3 tasks'); assert.equal(B.shortPhraseOf(one), 'Blocks “Tag batch-88 release”'); assert.equal(B.shortPhraseOf(null), '');

// blockers sort first: a high-priority waiter, then more waiters, then none
const w = i => B.weightOf(i);
assert.ok(w(B.reviewInfo(TASKS, { board: 'b', taskId: 1, goalId: 0 })) > w(a), 'high priority outweighs a count of three');
assert.ok(w(a) > w(one) && w(one) > 0 && w(null) === 0 && B.phraseOf(null) === '');

// the refresh: one query per team, cached; a failed query says nothing and never throws
let calls = [];
globalThis.fetch = async (url) => { calls.push(String(url)); if (/board=bad/.test(String(url))) return new Response('no', { status: 500 }); return new Response(JSON.stringify({ tasks: TASKS }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
const items = [{ key: 'rv1', kind: 'review', team: 'b', taskId: 1, goalId: 7, goalTitle: 'Checkout' }, { key: 'ag1', kind: 'agent', team: 'b', names: ['Frontend Dev'] }, { key: 'rv2', kind: 'review', team: 'bad', taskId: 1, goalId: 0 }];
assert.equal(await B.refreshBlockers(items), true, 'the first refresh has something new to say');
assert.equal(calls.length, 2, 'one query per team, not per item: ' + calls.join(' | '));
assert.match(calls[0], /board=b/); assert.match(calls[0], /status=in_progress/); assert.match(calls[0], /status=review_pending/);
assert.equal(B.phraseOf(B.blockerOf('rv1')), 'High priority: 2 tasks wait on this'); assert.equal(B.phraseOf(B.blockerOf('ag1')), '3 tasks wait on this');
assert.equal(B.blockerOf('rv2'), null, 'a team whose query failed says nothing');
assert.equal(await B.refreshBlockers(items), false, 'nothing changed');
assert.equal(calls.length, 2, 'the answers are kept for 30 seconds');
console.log('inbox_blockers: ok');
