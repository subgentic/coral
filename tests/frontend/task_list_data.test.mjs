// task_list_data.js: the dock task list's pure parts: the review flag, a row's state words, the sort clicks and the shown order (#8386).
import assert from 'node:assert/strict';
import { canComplete, canSendBack, reviewRequested, taskStatus, defaultSort, nextSort, filterAndSortTasks } from '../../coral-go/pkg/frontend/static/task_list_data.js';

assert.equal(reviewRequested(null), false);
assert.equal(reviewRequested({}), false);
assert.equal(reviewRequested({ review_requested: true }), true, 'a list item says it');
assert.equal(reviewRequested({ workflow: { completion_review: {} } }), true, 'a full task carries it in its workflow');

const word = (t) => { const s = taskStatus(t); return [s.className, s.detail, s.label]; };
assert.deepEqual(word({ status: 'completed' }), ['completed', 'Finished', 'Finished']);
assert.deepEqual(word({ status: 'in_progress', outcome: 'failed' }), ['completed', 'Finished', 'Finished'], 'a failed outcome is finished whatever the status says');
assert.deepEqual(word({ status: 'in_progress', workflow: { outcome: 'failed' } }), ['completed', 'Finished', 'Finished']);
assert.deepEqual(word({ status: 'review_pending' }), ['blocked', 'Open · Review pending', 'Review']);
assert.deepEqual(word({ status: 'in_progress', review_requested: true }), ['blocked', 'Open · Review requested', 'Open · Review requested']);
assert.deepEqual(word({ status: 'in_progress', claimed_at: '2026-10-20T10:00:00Z' }), ['in-progress', 'Claimed · Working', 'Claimed']);
assert.deepEqual(word({ status: 'in_progress' }), ['in-progress', 'Open · Working', 'Open']);
assert.deepEqual(word({ status: 'skipped' }), ['cancelled', 'Cancelled', 'Cancelled']);
assert.deepEqual(word({ status: 'blocked' }), ['blocked', 'Blocked: waiting for prerequisites', 'Blocked']);
assert.deepEqual(word({ status: 'draft' }), ['pending', 'Open · Draft', 'Open · Draft']);
assert.deepEqual(word({ status: 'pending' }), ['pending', 'Open', 'Open']);

// The clicks on one column: choose, turn round, back to the default; another column starts again.
let s = defaultSort();
assert.deepEqual(s, { field: 'created_at', asc: false, explicit: false, clicks: 0 });
s = nextSort(s, 'cost'); assert.deepEqual(s, { field: 'cost', asc: false, explicit: true, clicks: 1 });
s = nextSort(s, 'cost'); assert.deepEqual(s, { field: 'cost', asc: true, explicit: true, clicks: 2 });
s = nextSort(s, 'cost'); assert.deepEqual(s, defaultSort(), 'the third click gives the default order back');
s = nextSort(s, 'priority'); assert.deepEqual(s, { field: 'priority', asc: true, explicit: true, clicks: 1 }, 'priority starts ascending: critical first');
s = nextSort(s, 'id'); assert.deepEqual(s, { field: 'id', asc: false, explicit: true, clicks: 1 }, 'another column starts again');
assert.notEqual(defaultSort(), defaultSort(), 'each caller gets its own object');

const T = (id, status, extra = {}) => ({ id, status, created_at: `2026-10-0${id}T00:00:00Z`, ...extra });
const ids = (l) => l.map(t => t.id).join(',');
const list = [T(1, 'completed'), T(2, 'pending'), T(3, 'in_progress'), T(4, 'skipped'), T(5, 'pending')];
assert.equal(ids(filterAndSortTasks(list, defaultSort())), '5,3,2,4,1', 'default: open work newest first, then the finished, newest first');
assert.equal(ids(filterAndSortTasks(list, defaultSort(), { hideCompleted: true })), '5,3,2', 'Hide done drops completed and skipped');
assert.equal(ids(filterAndSortTasks(list, defaultSort(), { querying: true, hideCompleted: true })), '1,2,3,4,5', 'a search keeps the server order and is not cut by Hide done');
const byId = nextSort(defaultSort(), 'id');
assert.equal(ids(filterAndSortTasks(list, byId)), '5,4,3,2,1', 'a chosen column sorts the whole list, descending first');
assert.equal(ids(filterAndSortTasks(list, nextSort(byId, 'id'))), '1,2,3,4,5', 'turned round');
const pr = [T(1, 'pending', { priority: 'low' }), T(2, 'pending', { priority: 'critical' }), T(3, 'pending'), T(4, 'pending', { priority: 'high' })];
assert.equal(ids(filterAndSortTasks(pr, nextSort(defaultSort(), 'priority'))), '2,4,3,1', 'critical first; no priority sorts as normal');
const cost = [T(1, 'pending', { cost_usd: 2 }), T(2, 'pending'), T(3, 'pending', { cost_usd: 5 })];
assert.equal(ids(filterAndSortTasks(cost, nextSort(defaultSort(), 'cost'))), '3,1,2', 'dearest first; no cost sorts last');
const who = [T(1, 'pending', { assigned_to: 'b' }), T(2, 'pending', { assigned_to: 'a' }), T(3, 'pending')];
assert.equal(ids(filterAndSortTasks(who, nextSort(nextSort(defaultSort(), 'assignee'), 'assignee'))), '3,2,1', 'assignee ascending: none first');
const src = [T(1, 'pending', { _source: 'subagent' }), T(2, 'pending', { _source: 'board' })];
assert.equal(ids(filterAndSortTasks(src, nextSort(nextSort(defaultSort(), 'type'), 'type'))), '2,1', 'type: board before subagent when ascending');
assert.deepEqual(filterAndSortTasks(list, defaultSort()).length, 5);
assert.equal(list[0].id, 1, 'the list the caller passed is not reordered');
// "Not yet: send back" (#10337): offered for a task with an agent, and not to a Hub viewer whose access for the board's machine is below Interact
assert.equal(canSendBack({ assigned_to: 'Worker' }, ''), true, 'a task with an agent, no Hub limit');
assert.equal(canSendBack({ assigned_to: 'Worker' }, 'View only through Coral Hub'), false, 'a view-only Hub viewer does not get it');
assert.equal(canSendBack({ assigned_to: '' }, ''), false, 'no agent to tell');
assert.equal(canSendBack(null, ''), false);
// Complete (#10337): the same Interact tier as the board post, so a view-only Hub viewer does not get it either; a blocked task or a draft never does
assert.equal(canComplete({ status: 'in_progress' }, ''), true);
assert.equal(canComplete({ status: 'pending' }, 'View only through Coral Hub'), false, 'a view-only Hub viewer');
assert.equal(canComplete({ status: 'blocked' }, ''), false, 'a blocked task');
assert.equal(canComplete({ status: 'draft' }, ''), false, 'a draft');
assert.equal(canComplete(null, ''), false);
console.log('task_list_data: ok');
