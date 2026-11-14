// #14601 (beta run 3): "Goals shows No open goals and Done 0 after the goal finished". GET /api/goals answers the open goals only unless state is asked for, so the Done pill had nothing to show. listInboxGoals now also reads
// state=done (a second read, so finished goals never crowd an open one out of the first page) and merges the two, once each.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const asked = [];
const rows = { '/api/goals?limit=100': [{ id: 1, board_id: 'alpha', title: 'Open one', state: 'active', updated_at: '2026-11-08T10:00:00Z' }],
    '/api/goals?state=dropped&limit=100': [{ id: 3, board_id: 'alpha', title: 'Dropped one', state: 'dropped', updated_at: '2026-11-08T07:00:00Z' }],
    '/api/goals?state=done&limit=100': [{ id: 2, board_id: 'alpha', title: 'Finished one', state: 'done', updated_at: '2026-11-08T09:00:00Z' }, { id: 1, board_id: 'alpha', title: 'Open one', state: 'active', updated_at: '2026-11-08T10:00:00Z' }] };
let failDone = false;
globalThis.fetch = window.fetch = async url => {
    const u = String(url); asked.push(u);
    if (u in rows && !(failDone && u.includes('state=done'))) return new Response(JSON.stringify({ goals: rows[u] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 500 });
};
const C = await importUi('inbox_coral');
const { readFileSync } = await import('node:fs');
const source = name => readFileSync(new URL(`../../coral-go/pkg/frontend/static/${name}.js`, import.meta.url), 'utf8');
// ONE request per call (Security's one read per gap; the Hub's query census): the open goals by default, the finished ones only when asked for
let got = await C.listInboxGoals();
assert.deepEqual(asked.filter(u => u.startsWith('/api/goals')), ['/api/goals?limit=100'], 'the default read is the one open-goals request, as before: ' + asked.join(' | '));
assert.deepEqual(got.map(g => g.title), ['Open one']);
asked.length = 0;
got = await C.listInboxGoals(true);
assert.deepEqual(asked.filter(u => u.startsWith('/api/goals')), ['/api/goals?state=done&limit=100'], 'the Done read is the one finished-goals request: ' + asked.join(' | '));
assert.ok(got.some(g => g.title === 'Finished one'));
assert.equal(C.goalsReadFailed(), false);
failDone = true;
await C.listInboxGoals(true);
assert.equal(C.goalsReadFailed(), true, 'a failed read says so (the caller backs off)');
// a whole page of finished goals: there may be newer ones not listed, and the Done list says so; a short page does not
failDone = false;
await C.listInboxGoals(true);
assert.equal(C.doneGoalsCapped(), false, 'two finished goals are not a full page');
rows['/api/goals?state=done&limit=100'] = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, board_id: 'alpha', title: 'Finished ' + i, state: 'done', updated_at: '2026-11-08T08:00:00Z' }));
await C.listInboxGoals(true);
assert.equal(C.doneGoalsCapped(), true, 'a full page of finished goals: there may be more');
assert.equal(source('inbox_sidebar').includes('Newer goals may be missing when this limit is reached.') && !source('inbox_sidebar').includes('newer ones are not listed'), true, 'the note is conditional: it does not claim known omissions');
// the Dropped pill (#16371): its own one request
asked.length = 0;
got = await C.listInboxGoals('dropped');
assert.deepEqual(asked.filter(u => u.startsWith('/api/goals')), ['/api/goals?state=dropped&limit=100'], 'the Dropped read is the one dropped-goals request: ' + asked.join(' | '));
assert.deepEqual(got.map(g => g.title), ['Dropped one']);
console.log('PASS inbox_goals_done_read: the Done pill has the finished goals');
