// #12161 (the Operator): a goal whose tasks are all done is a "Goal looks done" item only once its latest task completion is a quiet period old (goal_done_quiet_minutes, 15 by default), so its driver has the
// time to add the next tasks; the page applies the same rule as the server (needs-you, the count and the phone push), and wakes at the end of the period.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { doneGoals, quietMs, quietEndsAt, nextQuietEnd } = await import(pathToFileURL(path.resolve(here, '../../coral-go/pkg/frontend/static/goal_done.js')).href);

const MIN = 60000, now = Date.parse('2026-11-02T12:00:00Z');
const at = minutesAgo => new Date(now - minutesAgo * MIN).toISOString();
const goal = (id, minutesAgo, over = {}) => ({ id, state: 'active', rollup: { done: 2, active: 0, blocked: 0, queued: 0 }, ...(minutesAgo == null ? {} : { looks_done_at: at(minutesAgo) }), ...over });
const team = () => 'team';
const ids = (goals, settings = {}) => doneGoals(goals, team, settings, now).map(g => g.id);

// the period: 15 minutes unless the setting says otherwise
assert.equal(quietMs({}), 15 * MIN);
assert.equal(quietMs({ goal_done_quiet_minutes: '30' }), 30 * MIN);
assert.equal(quietMs({ goal_done_quiet_minutes: '0' }), 0);
for (const bad of ['', 'x', '-1', '1441', '1.5']) assert.equal(quietMs({ goal_done_quiet_minutes: bad }), 15 * MIN, `unreadable or out of range: ${bad}`);

// 14 minutes: no item; 16 minutes: the item
assert.deepEqual(ids([goal(1, 14)]), [], '14 minutes after the last task: not yet');
assert.deepEqual(ids([goal(1, 16)]), [1], '16 minutes after: the item');
assert.deepEqual(ids([goal(1, 15)]), [1], 'exactly 15 is over');
// a goal with an open task is not one at all (a task added in the window cancels it)
assert.deepEqual(ids([goal(1, 16, { rollup: { done: 2, active: 0, blocked: 0, queued: 1 } })]), []);
// an older server sends no completion time: the goal is not held back (the rule before)
assert.deepEqual(ids([goal(1, null)]), [1]);
// the setting moves the period
assert.deepEqual(ids([goal(1, 20)], { goal_done_quiet_minutes: '30' }), [], '30 minutes: not yet at 20');
assert.deepEqual(ids([goal(1, 20)], { goal_done_quiet_minutes: '0' }), [1]);

// when the page draws it: the end of the period, and the soonest of several
assert.equal(quietEndsAt(goal(1, 10), {}), now - 10 * MIN + 15 * MIN);
assert.equal(quietEndsAt(goal(1, null), {}), 0);
assert.equal(nextQuietEnd([goal(1, 10), goal(2, 3), goal(3, 40)], team, {}, now), 5 * MIN, 'the goal at 10 minutes is the next, in 5');
assert.equal(nextQuietEnd([goal(3, 40)], team, {}, now), null, 'nothing waiting');
assert.equal(nextQuietEnd([goal(1, 10, { rollup: { done: 1, active: 1, blocked: 0, queued: 0 } })], team, {}, now), null, 'a goal with an open task is not waiting for its period');
console.log('goal_done_quiet: ok');
