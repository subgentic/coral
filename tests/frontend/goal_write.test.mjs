// #13503: a goal create, close or update through the Coral Hub carries the Hub's preview token. With the Hub's boot value goal_preview off (a computer's own dashboard, the self-hosted Hub) the write is exactly what it always was;
// with it on, the preview comes first, the write carries X-Hub-Goal-Preview and the SAME bytes, every write is previewed again, a token that ran out is asked for once more, and each of the Hub's words is one plain sentence.
import assert from 'node:assert/strict';
import { goalWrite, PREVIEW_HEADER, checkGoalBody, writeEach, BULK_GAP_MS, computerHasOperatorRoutes, offersOperatorChanges, operatorChangesNeedNewer, operatorChangesNote, OPERATOR_ROUTES_SINCE } from '../../coral-go/pkg/frontend/static/goal_write.js';
import { PREVIEW_WORDS } from '../../coral-go/pkg/frontend/static/goal_words.js';
import { LOCAL_SERVER } from '../../coral-go/pkg/frontend/static/server_base.js';

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
function rig({ on = true, previews = [], writes = [] } = {}) {
    const log = [];
    const serverFn = async (server, path, o) => { log.push({ kind: 'preview', server, path, body: JSON.parse(o.body), raw: o.body }); return previews.shift() || json({ token: 'tok' + log.length, expires: 'x', tier: 'interact', server, board: 'b' }); };
    const boardFn = async (project, path, o) => { log.push({ kind: 'write', project, path, method: o.method, headers: o.headers, body: o.body }); return writes.shift() || json({ ok: true }); };
    return { log, call: (action, goal, path, method, body) => goalWrite('@box/team-a', action, goal, path, method, body, { boardFn, serverFn, on: () => on }) };
}

// off: today's write, one request, no header
{
    const r = rig({ on: false });
    const resp = await r.call('goal_create', 0, '/goals', 'POST', { title: 'T' });
    assert.equal(resp.ok, true);
    assert.equal(r.log.length, 1); assert.equal(r.log[0].kind, 'write'); assert.equal(r.log[0].headers[PREVIEW_HEADER], undefined, 'no token header with the flag off');
    assert.equal(r.log[0].body, '{"title":"T"}');
}
// An account read that failed or timed out may miss the Hub's preview flag.
{
    const r = rig({ on: false, writes: [json({ error: 'preview_required' }, 400)] });
    const resp = await r.call('goal_create', 0, '/goals', 'POST', { title: 'T' });
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, PREVIEW_WORDS.preview_required);
    assert.match(PREVIEW_WORDS.preview_required, /reload.*try again/i);
    assert.equal(r.log.length, 1, 'no automatic retry of a refused write');
}
// on: preview first (board without the server prefix, goal id for a close), then the write with the token and the same bytes
{
    const r = rig();
    const body = { subscriber_id: 'Operator', reason: 'done "quoted"', state: 'done' };
    const resp = await r.call('goal_close', 7, '/goals/7/close', 'POST', body);
    assert.equal(resp.ok, true);
    assert.deepEqual(r.log.map(x => x.kind), ['preview', 'write']);
    assert.equal(r.log[0].server, 'box'); assert.equal(r.log[0].path, '/api/hub/goal-preview');
    assert.deepEqual(r.log[0].body, { board: 'team-a', action: 'goal_close', goal: 7, body: JSON.stringify(body) });
    assert.equal(r.log[1].headers[PREVIEW_HEADER], 'tok1'); assert.equal(r.log[1].body, JSON.stringify(body), 'the write is the previewed bytes, exactly');
    assert.equal(r.log[0].body.body, r.log[1].body, 'preview body === write body');
}
// a create has no goal key; two writes are two previews (before EVERY write, never once)
{
    const r = rig();
    await r.call('goal_create', 0, '/goals', 'POST', { title: 'A' });
    await r.call('goal_create', 0, '/goals', 'POST', { title: 'B' });
    assert.equal('goal' in r.log[0].body, false);
    assert.deepEqual(r.log.map(x => x.kind), ['preview', 'write', 'preview', 'write']);
    assert.notEqual(r.log[1].headers[PREVIEW_HEADER], r.log[3].headers[PREVIEW_HEADER], 'one token, one write');
}
// a token that ran out is asked for once more and the write sent again (the same bytes)
{
    const r = rig({ writes: [json({ error: 'preview_expired' }, 409)] });
    const resp = await r.call('goal_update', 3, '/goals/3', 'PATCH', { subscriber_id: 'Operator', state: 'active' });
    assert.equal(resp.ok, true);
    assert.deepEqual(r.log.map(x => x.kind), ['preview', 'write', 'preview', 'write']);
    assert.equal(r.log[3].body, r.log[1].body);
    const twice = rig({ writes: [json({ error: 'preview_expired' }, 409), json({ error: 'preview_expired' }, 409)] });
    const bad = await twice.call('goal_update', 3, '/goals/3', 'PATCH', { subscriber_id: 'Operator', state: 'active' });
    assert.equal(bad.status, 409); assert.equal((await bad.json()).code, 'preview_expired'); assert.equal(twice.log.length, 4, 'asked again once, not forever');
}
// every word of the Hub is a plain sentence in the editor's own error shape {code, error}
for (const [word, status] of [['preview_required', 400], ['preview_invalid', 403], ['preview_used', 409], ['outcome_unknown', 409], ['mode_too_low', 403], ['bad_request', 400]]) {
    const r = rig({ writes: [json({ error: word }, status)] });
    const resp = await r.call('goal_close', 1, '/goals/1/close', 'POST', { subscriber_id: 'Operator', state: 'done' });
    const e = await resp.json();
    assert.equal(resp.status, status); assert.equal(e.code, word); assert.equal(e.error, PREVIEW_WORDS[word]); assert.ok(e.error.length > 20 && !e.error.includes('_'), `${word} is a sentence`);
}
// outcome_unknown (the computer restarted since the preview): said once, the write is never sent again and no second preview is asked for
{
    const r = rig({ writes: [json({ error: 'outcome_unknown' }, 409)] });
    const resp = await r.call('goal_close', 1, '/goals/1/close', 'POST', { subscriber_id: 'Operator', state: 'done' });
    assert.equal(resp.status, 409); assert.equal((await resp.json()).code, 'outcome_unknown');
    assert.deepEqual(r.log.map(x => x.kind), ['preview', 'write'], 'one preview, one write: nothing is retried');
}
// preview errors: the Hub's words and the status words (429, 413, 503 with and without busy), a network failure; the write is never sent
for (const [resp, word] of [[json({ error: 'mode_too_low' }, 403), 'mode_too_low'], [json({ error: 'x' }, 429), 'too_many_requests'], [json({}, 413), 'too_large'], [json({ error: 'busy' }, 503), 'busy'], [json({ error: 'remote unavailable' }, 503), 'unreachable'], [json({ error: 'preview_unavailable' }, 409), 'preview_unavailable']]) {
    const r = rig({ previews: [resp] });
    const out = await r.call('goal_create', 0, '/goals', 'POST', { title: 'T' });
    assert.equal((await out.json()).code, word); assert.equal(r.log.filter(x => x.kind === 'write').length, 0, `${word}: nothing was written`);
}
{
    const r = rig();
    const out = await goalWrite('@box/team-a', 'goal_create', 0, '/goals', 'POST', {}, { boardFn: async () => json({}), serverFn: async () => { throw new Error('offline'); }, on: () => true });
    assert.equal((await out.json()).code, 'unreachable'); void r;
}
// the computer's own refusal (a goal with no title) comes through as the computer said it, not as a Hub word
{
    const own = { code: 'goal_title_required', error: 'A goal needs a title.' };
    const r = rig({ writes: [json(own, 400)] });
    const resp = await r.call('goal_create', 0, '/goals', 'POST', { title: '' });
    assert.equal(resp.status, 400); assert.deepEqual(await resp.json(), own);
}
// a task add is never previewed, whatever the flag says
{
    const r = rig();
    await r.call('task_add', 0, '/tasks', 'POST', { title: 't' });
    assert.deepEqual(r.log.map(x => x.kind), ['write'], 'the Hub leaves a task add alone');
}

// the shapes coral-hub checks (its answer a): subscriber_id exactly 'Operator', a close's state and reason, an update's fields and caps; a body outside them is not sent
{
    const ok = (a, b) => assert.equal(checkGoalBody(a, b), '', JSON.stringify(b));
    const no = (a, b) => assert.notEqual(checkGoalBody(a, b), '', JSON.stringify(b));
    ok('goal_close', { subscriber_id: 'Operator', state: 'done', reason: 'x'.repeat(500) }); ok('goal_close', { subscriber_id: 'Operator', state: 'dropped' });
    no('goal_close', { subscriber_id: 'operator', state: 'done' }); no('goal_close', { state: 'done' }); no('goal_close', { subscriber_id: 'Operator', state: 'active' });
    no('goal_close', { subscriber_id: 'Operator', state: 'done', reason: 'x'.repeat(501) }); no('goal_close', { subscriber_id: 'Operator', state: 'done', extra: 1 });
    ok('goal_update', { subscriber_id: 'Operator', state: 'active' }); ok('goal_update', { subscriber_id: 'Operator', title: 't'.repeat(200), done_when: 'd' });
    no('goal_update', { subscriber_id: 'Operator' }); no('goal_update', { subscriber_id: 'Operator', title: 't'.repeat(201) }); no('goal_update', { subscriber_id: 'Operator', state: 'closed' }); no('goal_update', { subscriber_id: 'Operator', priority: 'high' });
    // what the dashboard sends is inside them (the five call sites)
    ok('goal_close', { subscriber_id: 'Operator', reason: 'r'.repeat(300), state: 'done' }); ok('goal_update', { subscriber_id: 'Operator', state: 'active' });
    // a body outside them is not previewed or written
    const r = rig(); const out = await r.call('goal_close', 1, '/goals/1/close', 'POST', { subscriber_id: 'op', state: 'done' });
    assert.equal(out.status, 400); assert.equal(r.log.length, 0, 'nothing was sent');
}
// the Operator's driver change and move (#13517): coral-hub's shapes (no subscriber_id; driver 0-128 characters, '' clears; to_project one board name), previewed with their own actions and the goal bound
{
    const ok = (a, b) => assert.equal(checkGoalBody(a, b), '', JSON.stringify(b));
    const no = (a, b) => assert.notEqual(checkGoalBody(a, b), '', JSON.stringify(b));
    ok('goal_driver', { driver: '' }); ok('goal_driver', { driver: 'd'.repeat(128) }); no('goal_driver', { driver: 'd'.repeat(129) }); no('goal_driver', {}); no('goal_driver', { driver: 'x', subscriber_id: 'Operator' }); no('goal_driver', { driver: 3 });
    ok('goal_move', { to_project: 'team-b' }); ok('goal_move', { to_project: 'team-b', driver: 'dev-1' }); no('goal_move', { to_project: '' }); no('goal_move', { to_project: '   ' }); no('goal_move', { to_project: 'a/b' }); no('goal_move', { to_project: 'a\\b' });
    no('goal_move', { to_project: 'x'.repeat(257) }); no('goal_move', { to_project: 'x', subscriber_id: 'Operator' }); no('goal_move', { to_project: 'x', driver: 'd'.repeat(129) }); no('goal_move', { driver: 'x' });
    const r = rig();
    await r.call('goal_driver', 4, '/goals/4/driver', 'POST', { driver: 'dev-1' });
    await r.call('goal_move', 4, '/goals/4/move', 'POST', { to_project: 'team-b', driver: '' });
    assert.deepEqual(r.log.map(x => x.kind), ['preview', 'write', 'preview', 'write']);
    assert.deepEqual([r.log[0].body.action, r.log[0].body.goal, r.log[2].body.action, r.log[2].body.goal], ['goal_driver', 4, 'goal_move', 4]);
    assert.equal(r.log[1].body, r.log[0].body.body); assert.equal(r.log[3].body, r.log[2].body.body); assert.ok(r.log[1].headers[PREVIEW_HEADER]);
    const bad = rig(); const out = await bad.call('goal_move', 4, '/goals/4/move', 'POST', { to_project: 'team-b', subscriber_id: 'Operator' });
    assert.equal(out.status, 400); assert.equal(bad.log.length, 0, 'a body outside the shape is not sent');
    // the computer's own answer passes through the Hub as the Hub gives it: a closed word with its readable message
    const own = { code: 'team_not_found', message: 'No team by that name on this computer.' };
    const pass = rig({ writes: [json(own, 404)] });
    const p = await pass.call('goal_move', 4, '/goals/4/move', 'POST', { to_project: 'nope' });
    assert.equal(p.status, 404); assert.deepEqual(await p.json(), own);
}
// the Operator's driver/move buttons are offered through a Hub only for a computer that reports a Coral with the routes (an older one would answer not found)
{
    const has = v => computerHasOperatorRoutes('srv1', () => ({ coral_version: v }));
    for (const v of ['2.0.50', '2.0.51', '2.1.0', '3.0.0', '2.0.50-rc1', '2.0.50-beta', OPERATOR_ROUTES_SINCE]) assert.equal(has(v), true, v);
    for (const v of ['2.0.49', '2.0.49-rc2', '1.9.99', '', undefined, 'dev', 'not a version']) assert.equal(has(v), false, String(v));
    assert.equal(computerHasOperatorRoutes('srv1', () => ({ version: '2.0.50' })), true, "a self-hosted hub's entry says version");
    assert.equal(computerHasOperatorRoutes('srv1', () => ({})), false, 'no version reported: not offered');
    const yes = () => true, no = () => false;
    assert.equal(offersOperatorChanges(LOCAL_SERVER, { cloud: false, hub: false, has: no }), true, "a computer's own dashboard: always");
    assert.equal(offersOperatorChanges(LOCAL_SERVER, { cloud: true, hub: false, has: yes }), false, "coral-hub's Hub has no local computer");
    assert.equal(offersOperatorChanges('srv1', { cloud: true, hub: false, has: yes }), true, 'through coral-hub: a computer that has the routes');
    assert.equal(offersOperatorChanges('srv1', { cloud: true, hub: false, has: no }), false, 'through coral-hub: an older computer: hidden');
    assert.equal(offersOperatorChanges('srv1', { cloud: false, hub: true, has: yes }), true, "through our own Hub: a computer that has them");
    assert.equal(offersOperatorChanges('srv1', { cloud: false, hub: true, has: no }), false, 'through our own Hub: an older computer: hidden');
    assert.equal(offersOperatorChanges('srv1', { cloud: false, hub: false, has: yes }), false, 'neither Hub nor a local key: nothing to offer');
    // the note says why only where an older computer behind a Hub hides them
    assert.equal(operatorChangesNote(), 'Change driver and Move need Coral 2.0.50 on this computer.');
    assert.equal(operatorChangesNeedNewer('srv1', { cloud: true, hub: false, has: no }), true); assert.equal(operatorChangesNeedNewer('srv1', { cloud: false, hub: true, has: no }), true);
    assert.equal(operatorChangesNeedNewer('srv1', { cloud: true, hub: false, has: yes }), false, 'a computer that has them: no note');
    assert.equal(operatorChangesNeedNewer(LOCAL_SERVER, { cloud: false, hub: false, has: no }), false, "a computer's own dashboard: no note");
    assert.equal(operatorChangesNeedNewer(LOCAL_SERVER, { cloud: true, hub: false, has: no }), false, "coral-hub's own local: nothing to say");
}
// a bulk close with the preview on: one at a time, a pause between goals (about 10 a minute), progress said, and the Hub's 429 stops it (never loops, never retries); with it off: no pause, no limit
{
    assert.ok(BULK_GAP_MS >= 6000, 'about 10 a minute at most');
    const waits = [], said = [], ran = [];
    const list = [1, 2, 3, 4, 5, 6];
    const res = await writeEach(list, async g => { ran.push(g); return g === 4 ? json({ code: 'too_many_requests', error: 'x' }, 429) : json({ ok: true }); }, { on: () => true, wait: async ms => { waits.push(ms); }, say: t => said.push(t) });
    assert.deepEqual(ran, [1, 2, 3, 4], 'stopped at the 429: goals 5 and 6 were not tried');
    assert.equal(res.done, 3); assert.equal(res.failed, 0); assert.match(res.stopped, /half a minute\. 3 of 6 goals were changed; the rest are unchanged\./);
    assert.deepEqual(waits, [BULK_GAP_MS, BULK_GAP_MS, BULK_GAP_MS], 'a pause before every goal but the first');
    assert.equal(said[0], 'Changing goals: 1 of 6'); assert.equal(said.length, 4, 'progress for each goal tried');
    const one = await writeEach([1, 2, 3], async g => (g === 2 ? json({}, 429) : json({ ok: true })), { on: () => true, wait: async () => {} });
    assert.match(one.stopped, /1 of 3 goals was changed;/, 'one goal: "was"');
    const off = []; const all = await writeEach(list, async g => json({ ok: true }), { on: () => false, wait: async ms => off.push(ms), say: t => off.push(t) });
    assert.equal(all.done, 6); assert.deepEqual(off, [], 'flag off: no pause, no progress line, as before');
    const fails = await writeEach([1, 2], async g => { if (g === 1) throw new Error('x'); return json({}, 500); }, { on: () => false });
    assert.deepEqual([fails.done, fails.failed, fails.stopped], [0, 2, ''], 'a failure counts and the rest go on');
}
console.log('goal_write: ok');
