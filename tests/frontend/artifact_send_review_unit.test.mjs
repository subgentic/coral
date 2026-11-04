// #13152 (UI Reviewer's MUST on cb07ab02c): the same bytes can be a separate artifact in several teams, and the Inbox lists them as separate rows, so a send or a remove's outcome is keyed by project AND hash,
// never by hash alone. The real module (artifact_send_review.js) against a stubbed fetch: one hash in two teams, one team refusing; and the sending of one question, the removing, and the key itself.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const H = 'a'.repeat(64), H2 = 'b'.repeat(64);
const calls = [];
let refuse = new Set(); // projects that answer with a refusal
globalThis.fetch = window.fetch = async (url, opts = {}) => {
    const m = /\/api\/board\/([^/]+)\/artifacts\/([a-f0-9]{64})\/review/.exec(String(url));
    assert.ok(m, 'only the review route is called: ' + url);
    const project = decodeURIComponent(m[1]), method = opts.method || 'GET';
    calls.push({ project, hex: m[2], method, body: opts.body ? JSON.parse(opts.body) : null });
    if (refuse.has(project)) return Response.json({ error: `${project} has five tags already` }, { status: 400 });
    return Response.json(method === 'PUT' ? { id: m[2], tags: ['for review'], question: 'q' } : { id: m[2], tags: [] });
};
const { changeMany, reviewKey, sendForReview } = await importUi('artifact_send_review');
const A = reviewKey('team-a', H), B = reviewKey('team-b', H);

// the key: project and hash, and no two pairs share one
assert.notEqual(A, B, 'the same hash in two teams is two keys');
assert.notEqual(reviewKey('a|b', 'c'), reviewKey('a', 'b|c'), 'a team name holding a separator cannot run into the hash');
assert.deepEqual(JSON.parse(A), ['team-a', H]);

for (const remove of [false, true]) {
    const verb = remove ? 'remove' : 'send';
    // mixed: team-a succeeds, team-b refuses the same hash: only A is a success, B is the one that failed
    calls.length = 0; refuse = new Set(['team-b']);
    let r = await changeMany([{ project: 'team-a', hex: H }, { project: 'team-b', hex: H }], { question: 'Approve?', remove });
    assert.deepEqual([...r.ok.keys()], [A], `${verb}, mixed: only team-a's row succeeded`);
    assert.equal(r.failed, 1, `${verb}, mixed: one failure`);
    assert.match(r.why, /team-b has five tags/, `${verb}, mixed: the reason is team-b's`);
    assert.ok(!r.ok.has(B), `${verb}, mixed: team-b's row is not reported as a success`);
    assert.deepEqual(calls.map(c => `${c.method} ${c.project}`), remove ? ['DELETE team-a', 'DELETE team-b'] : ['PUT team-a', 'PUT team-b'], `${verb}, mixed: each team is its own call`);
    // the other way round: team-b succeeds, team-a refuses
    calls.length = 0; refuse = new Set(['team-a']);
    r = await changeMany([{ project: 'team-a', hex: H }, { project: 'team-b', hex: H }], { question: '', remove });
    assert.deepEqual([...r.ok.keys()], [B], `${verb}, mixed the other way: only team-b's row succeeded`);
    assert.equal(r.failed, 1);
    // both succeed: two rows, one per team
    calls.length = 0; refuse = new Set();
    r = await changeMany([{ project: 'team-a', hex: H }, { project: 'team-b', hex: H }, { project: 'team-a', hex: H2 }], { question: 'Approve?', remove });
    assert.deepEqual([...r.ok.keys()].sort(), [A, B, reviewKey('team-a', H2)].sort(), `${verb}, both succeed: every row of every team`);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.ok.get(A), remove ? [] : ['for review'], `${verb}: the tags are the server's`);
    // both refuse
    refuse = new Set(['team-a', 'team-b']);
    r = await changeMany([{ project: 'team-a', hex: H }, { project: 'team-b', hex: H }], { remove });
    assert.equal(r.ok.size, 0, `${verb}, both refuse: no success`);
    assert.equal(r.failed, 2);
}
// a sent question goes in the body, cleaned by the caller; Remove sends no body
calls.length = 0; refuse = new Set();
await sendForReview('team-a', H, '  Approve   it?  ');
assert.deepEqual(calls[0].body, { question: 'Approve   it?' }, 'the question is trimmed');
await changeMany([{ project: 'team-a', hex: H }], { remove: true });
assert.equal(calls[1].body, null, 'DELETE takes no body');
console.log('PASS artifact_send_review: outcomes are keyed by project and hash (mixed, both succeed, both refuse; send and remove)');
