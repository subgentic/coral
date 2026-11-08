// #14601 (beta run 3): "Goals shows No open goals and Done 0 after the goal finished". GET /api/goals answers the open goals only unless state is asked for, so the Done pill had nothing to show. listInboxGoals now also reads
// state=done (a second read, so finished goals never crowd an open one out of the first page) and merges the two, once each.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const asked = [];
const rows = { '/api/goals?limit=100': [{ id: 1, board_id: 'alpha', title: 'Open one', state: 'active', updated_at: '2026-11-08T10:00:00Z' }],
    '/api/goals?state=done&limit=100': [{ id: 2, board_id: 'alpha', title: 'Finished one', state: 'done', updated_at: '2026-11-08T09:00:00Z' }, { id: 1, board_id: 'alpha', title: 'Open one', state: 'active', updated_at: '2026-11-08T10:00:00Z' }] };
let failDone = false;
globalThis.fetch = window.fetch = async url => {
    const u = String(url); asked.push(u);
    if (u in rows && !(failDone && u.includes('state=done'))) return new Response(JSON.stringify({ goals: rows[u] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 500 });
};
const C = await importUi('inbox_coral');
let got = await C.listInboxGoals();
assert.ok(asked.some(u => u.includes('/api/goals?state=done')), 'the finished goals are asked for: ' + asked.join(' | '));
assert.deepEqual(got.map(g => g.title).sort(), ['Finished one', 'Open one'], 'open and finished, a goal once');
assert.equal(C.goalsReadFailed(), false);
failDone = true;
got = await C.listInboxGoals();
assert.deepEqual(got.map(g => g.title), ['Open one'], 'a failed read of the finished ones leaves the open ones');
assert.equal(C.goalsReadFailed(), true, 'and says the read failed (the caller backs off)');
// a whole page of finished goals: there may be newer ones not listed, and the Done list says so; a short page does not
failDone = false;
assert.equal(C.doneGoalsCapped(), false, 'two finished goals are not a full page');
rows['/api/goals?state=done&limit=100'] = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, board_id: 'alpha', title: 'Finished ' + i, state: 'done', updated_at: '2026-11-08T08:00:00Z' }));
await C.listInboxGoals();
assert.equal(C.doneGoalsCapped(), true, 'a full page of finished goals: there may be more');
console.log('PASS inbox_goals_done_read: the Done pill has the finished goals');
