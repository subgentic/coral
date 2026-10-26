// goal_filters.js: the Inbox Goals folder's filters: what a goal must match, the order, the chips and the clean of a kept value (#8596).
import assert from 'node:assert/strict';

// The model keeps its choice in the browser store; node has none, so the store module is given a stand-in before the import.
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const GF = await import('../../coral-go/pkg/frontend/static/goal_filters.js');

const goals = [
    { id: 1, board_id: 'team-a', title: 'Ship the importer', outcome: 'Importer is live', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-20T10:00:00Z' },
    { id: 2, board_id: 'team-a', title: 'Cut the cold start', outcome: 'Start under 2 s', state: 'Blocked', driver: 'Backend Dev', updated_at: '2026-10-22T10:00:00Z' },
    { id: 3, board_id: 'team-b', title: 'Plan the migration', outcome: 'A plan reviewed', state: 'proposed', driver: 'Orchestrator', updated_at: '2026-10-24T10:00:00Z' },
];
const ids = f => goals.filter(g => GF.matches(g, { ...GF.EMPTY, ...f })).map(g => g.id).join();

assert.equal(ids({}), '1,2,3', 'no filter keeps every goal');
assert.equal(ids({ q: 'IMPORTER' }), '1', 'the search is any case and covers the title and the outcome');
assert.equal(ids({ q: 'under 2' }), '2');
assert.equal(ids({ q: 'team-b' }), '3', 'and the team words');
assert.equal(ids({ q: 'backend' }), '2', 'and the driver');
assert.equal(ids({ state: 'blocked' }), '2', 'the pill state is any case');
assert.equal(ids({ state: 'active' }), '1');
assert.equal(ids({ team: 'team-a' }), '1,2');
assert.equal(ids({ driver: 'Orchestrator' }), '1,3');
assert.equal(ids({ from: '2026-10-22' }), '2,3', 'updated since: the day itself counts');
assert.equal(ids({ team: 'team-a', driver: 'Orchestrator', from: '2026-10-21' }), '', 'filters narrow together');
assert.equal(GF.matches(goals[0], { ...GF.EMPTY, q: 'cold' }, () => 'Other team'), false, 'the team words come from teamOf');
assert.equal(GF.matches(goals[0], { ...GF.EMPTY, q: 'other team' }, () => 'Other team'), true);

assert.equal(GF.ordered(goals, GF.EMPTY).map(g => g.id).join(), '3,2,1', 'newest update first by default');
assert.equal(GF.ordered(goals, { ...GF.EMPTY, sort: 'oldest' }).map(g => g.id).join(), '1,2,3');
assert.equal(GF.ordered(goals, { ...GF.EMPTY, sort: 'title' }).map(g => g.id).join(), '2,3,1', 'by title A to Z');
assert.equal(GF.ordered(goals, { ...GF.EMPTY, sort: 'nonsense' }).map(g => g.id).join(), '3,2,1', 'an unknown order is the default');
assert.equal(goals[0].id, 1, 'the list the caller passed is not reordered');

assert.deepEqual(GF.clean({ team: 'x'.repeat(300), driver: 5, from: 'not a day', state: 'other', sort: 'title' }), { ...GF.EMPTY, team: 'x'.repeat(200), sort: 'title' }, 'a kept value that is not valid is dropped');
GF.setTeamNames(new Map([['team-a', 'Alpha']]));
assert.deepEqual(GF.chips({ ...GF.EMPTY, team: 'team-a', driver: 'Orchestrator', from: '2026-10-21', state: 'active', q: 'x' }).map(c => c.label), ['Search: x', 'Team: Alpha', 'Driver: Orchestrator', 'Updated since 2026-10-21'], 'the pill state has no chip of its own');
assert.equal(GF.isFiltered({ ...GF.EMPTY, state: 'blocked' }), true);
assert.equal(GF.isFiltered({ ...GF.EMPTY, sort: 'title' }), false, 'the order alone does not narrow');
assert.deepEqual(GF.without({ ...GF.EMPTY, team: 'team-a', driver: 'D' }, 'team'), { ...GF.EMPTY, driver: 'D' });

GF.saveFilters({ ...GF.EMPTY, team: 'team-b', state: 'done' });
assert.deepEqual(GF.loadFilters(), { ...GF.EMPTY, team: 'team-b', state: 'done' }, 'what is chosen is kept for the folder');
GF.saveFilters(GF.EMPTY);
assert.deepEqual(GF.loadFilters(), GF.EMPTY, 'nothing chosen keeps nothing');
console.log('goal_filters: ok');
