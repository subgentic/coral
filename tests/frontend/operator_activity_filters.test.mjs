// The Activity folder's filters (#12070): what a search and each filter match, the order, and that the search words are not kept.
import assert from 'node:assert/strict';
import * as AF from '../../coral-go/pkg/frontend/static/operator_activity_filters.js';

const row = (id, o) => ({ id, at: `2026-11-0${id}T10:00:00Z`, actor: 'local', action: 'approve', item_kind: 'file', item_id: 'x', team: 'alpha', title: `File ${id}`, note: '', source: 'local', ...o });
const rows = [row(1, { title: 'Plan', note: 'looks good' }), row(2, { action: 'deny', team: 'beta', note: 'Not this quarter' }), row(3, { action: 'goal_close', item_kind: 'goal', title: 'Ship it', note: 'done: shipped' })];
const ids = (f) => AF.ordered(rows.filter(r => AF.matches(r, f)), f).map(r => r.id);

assert.deepEqual(ids(AF.EMPTY), [3, 2, 1], 'newest first');
assert.deepEqual(ids({ ...AF.EMPTY, sort: 'oldest' }), [1, 2, 3], 'the other order');
assert.deepEqual(ids({ ...AF.EMPTY, q: 'quarter' }), [2], 'the search covers the note');
assert.deepEqual(ids({ ...AF.EMPTY, q: 'denied' }), [2], 'and the words of the action');
assert.deepEqual(ids({ ...AF.EMPTY, q: 'ship' }), [3], 'and the title');
assert.deepEqual(ids({ ...AF.EMPTY, team: 'beta' }), [2]);
assert.deepEqual(ids({ ...AF.EMPTY, action: 'goal_close' }), [3]);
assert.deepEqual(ids({ ...AF.EMPTY, action: 'bogus' }), [3, 2, 1], 'an action that is not one is no filter');
assert.deepEqual(ids({ ...AF.EMPTY, from: '2026-11-02' }), [3, 2], 'since a day');
assert.equal(AF.isFiltered(AF.EMPTY), false); assert.equal(AF.isFiltered({ ...AF.EMPTY, team: 'beta' }), true);
assert.equal(AF.isFiltered({ ...AF.EMPTY, sort: 'oldest' }), false, 'the order alone does not narrow');
AF.setTeamNames(new Map([['beta', 'Beta team']]));
assert.ok(AF.chips({ ...AF.EMPTY, team: 'beta' }).some(c => /Team: Beta team/.test(c.label || c.text || String(c))), 'the team chip says the name');
assert.ok(AF.ACTIONS.includes('undone') && AF.ACTIONS.includes('goal_close'));
console.log('PASS operator_activity_filters: search, team, action, since, order');
