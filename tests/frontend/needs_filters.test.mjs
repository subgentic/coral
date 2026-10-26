// needs_filters.js: the Inbox Needs you folder's filters: the kind pills, Team, Agent, Waiting longer than, the order, the chips and what is kept (#8604).
import assert from 'node:assert/strict';

globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const NF = await import('../../coral-go/pkg/frontend/static/needs_filters.js');

const NOW = Date.parse('2026-10-26T12:00:00Z');
const min = n => new Date(NOW - n * 60000).toISOString();
const agents = [
    { id: 1, name: 'Frontend Dev', team: 'team-a', waiting_kind: 'permission', waiting_since: min(3) },
    { id: 2, name: 'Backend Dev', team: 'team-a', waiting_kind: 'question', waiting_since: min(30) },
    { id: 3, name: 'QA Engineer', team: 'team-b', waiting_kind: 'plan', waiting_since: min(120) },
    { id: 4, name: 'Docs Writer', team: 'team-b', waiting_kind: '', waiting_since: '' },
];
const ctx = { text: s => `${s.name} ${s.team} ${s.waiting_kind}`, teamOf: s => s.team, nameOf: s => s.name };
const ids = f => agents.filter(s => NF.matches(s, { ...NF.EMPTY, ...f }, ctx, NOW)).map(s => s.id).join();

assert.equal(ids({}), '1,2,3,4', 'no filter keeps every waiting agent');
assert.deepEqual(agents.map(NF.kindOf), ['permission', 'question', 'other', 'other'], 'a plan, an input request and a prompt the screen showed are Needs input');
assert.equal(ids({ kind: 'permission' }), '1'); assert.equal(ids({ kind: 'question' }), '2'); assert.equal(ids({ kind: 'other' }), '3,4');
assert.equal(ids({ team: 'team-b' }), '3,4'); assert.equal(ids({ agent: 'Backend Dev' }), '2');
assert.equal(ids({ q: 'FRONTEND' }), '1', 'the search is any case'); assert.equal(ids({ q: 'team-b' }), '3,4', 'and covers the words the caller gives');
assert.equal(ids({ longer: '5' }), '2,3', 'waiting at least 5 minutes: the one at 3 is out, and so is the one with no time');
assert.equal(ids({ longer: '60' }), '3'); assert.equal(ids({ longer: '240' }), '');
assert.equal(ids({ longer: '15', team: 'team-a' }), '2', 'filters narrow together');

assert.equal(NF.ordered(agents, NF.EMPTY).map(s => s.id).join(), '3,2,1,4', 'longest waiting first, the one with no time last');
assert.equal(NF.ordered(agents, { ...NF.EMPTY, sort: 'newest' }).map(s => s.id).join(), '1,2,3,4', 'least waiting first, the one with no time still last');
assert.equal(NF.ordered(agents, { ...NF.EMPTY, sort: 'nonsense' }).map(s => s.id).join(), '3,2,1,4', 'an unknown order is the default');
assert.equal(agents[0].id, 1, 'the list the caller passed is not reordered');

assert.deepEqual(NF.clean({ kind: 'plan', team: 5, agent: 'x'.repeat(200), longer: '7', sort: 'x' }), { ...NF.EMPTY, agent: 'x'.repeat(80) }, 'what is not valid is dropped');
assert.deepEqual(NF.chips({ ...NF.EMPTY, q: 'x', kind: 'question', team: 'team-a', agent: 'QA', longer: '60' }).map(c => c.label), ['Search: x', 'Team: team-a', 'Agent: QA', 'Waiting longer than 1 hour'], 'the pill has no chip of its own');
assert.equal(NF.isFiltered({ ...NF.EMPTY, kind: 'question' }), true); assert.equal(NF.isFiltered({ ...NF.EMPTY, sort: 'newest' }), false, 'the order alone does not narrow');
assert.deepEqual(NF.without({ ...NF.EMPTY, team: 'team-a', agent: 'QA' }, 'team'), { ...NF.EMPTY, agent: 'QA' });

NF.saveFilters({ ...NF.EMPTY, team: 'team-b', kind: 'other', q: 'not kept' });
assert.deepEqual(NF.loadFilters(), { ...NF.EMPTY, team: 'team-b', kind: 'other' }, 'kept for the folder, without the search words');
NF.saveFilters(NF.EMPTY);
assert.deepEqual(NF.loadFilters(), NF.EMPTY, 'nothing chosen keeps nothing');
console.log('needs_filters: ok');
