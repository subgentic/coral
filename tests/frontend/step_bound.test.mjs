// #14270 (review_changes_picture_browser hung once in three runs on the Mac, killed at 120 s with no assertion and no frame; 70 of 70 later runs passed, so the stalled step was never seen): a suite step that is a
// bare `await ev(...)` has no limit of its own, so a page request that never answers holds the whole suite until the runner kills it, and the failure names nothing. helpers/step_bound.js limits one step: it rejects at
// its limit naming the step, and adds what the page was still waiting for (requests with no end) when it can be asked. These pin that.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { bound } = createRequire(import.meta.url)('./helpers/step_bound.js');

// an answer in time is the answer
assert.equal(await bound(Promise.resolve(7), 200, 'a quick step'), 7);
// a step that never answers is named, at its limit
const t0 = Date.now();
await assert.rejects(bound(new Promise(() => {}), 80, 'the subscribe call'), e => /the subscribe call/.test(e.message) && /80 ms/.test(e.message));
assert.ok(Date.now() - t0 < 1000, 'it gave up at its limit, not later');
// the page's pending requests are added when a diagnosis can be asked, and a diagnosis that itself hangs or throws costs nothing
await assert.rejects(bound(new Promise(() => {}), 60, 'the inbox tab', async () => 'pending: /api/team-artifacts'), e => /the inbox tab/.test(e.message) && /pending: \/api\/team-artifacts/.test(e.message));
await assert.rejects(bound(new Promise(() => {}), 60, 'a step', () => new Promise(() => {})), e => /a step/.test(e.message));
await assert.rejects(bound(new Promise(() => {}), 60, 'a step', async () => { throw new Error('page gone'); }), e => /a step/.test(e.message));
// a step that fails by itself keeps its own error
await assert.rejects(bound(Promise.reject(new Error('boom')), 200, 'a step'), /boom/);
// the timer is cleared at an answer: a long limit does not hold the process
const done = Date.now(); await bound(Promise.resolve(1), 5000, 'a step'); assert.ok(Date.now() - done < 500);
console.log('step_bound: ok');
