// A lease that runs out is noticed by whoever asks first, and the rows are repainted either way (#9825, the flake of codex_display_activity_hint).
// The lease timer repaints the sidebar when a Codex activity hint expires with no new feed. A caller that asked (a poll, a render) in the millisecond between the expiry and the timer used to cancel the timer
// as "no hint any more" and the event never came: the count was right and the row kept its quiet look. Now the one that finds the lease over says so.
import assert from 'node:assert/strict';

const events = [];
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
globalThis.document = { dispatchEvent: e => { events.push(e.type); return true; } };
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const { trackDisplayHint, needsInputAttention, DISPLAY_HINT_MAX_AGE_MS } = await import('../../coral-go/pkg/frontend/static/display_activity_hint.js');

const row = at => ({ session_id: 's1', agent_type: 'codex', display_activity_hint: 'working', display_activity_hint_at: new Date(at).toISOString(), waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(at - 60000).toISOString() });
const tick = () => new Promise(r => setTimeout(r, 5));

// 1. a fresh hint quiets attention and arms the timer; the event has not come
const r = row(now - 9000);
assert.equal(needsInputAttention(r), false, 'a fresh hint quiets attention');
await tick();
assert.deepEqual(events, [], 'no event while the lease runs');

// 2. someone asks 1 ms after the lease ran out, before the timer: attention is back, and the repaint event comes (it did not)
now += 1000 + 1;
assert.equal(needsInputAttention(r), true, 'the lease is over: attention is back for the one who asked');
await tick();
assert.deepEqual(events, ['coral:display-hint-expired'], 'and the rows are told to repaint');

// 3. asked again: no second event for the same lease
assert.equal(needsInputAttention(r), true);
await tick();
assert.equal(events.length, 1, 'one event per lease');

// 4. a hint replaced by a newer feed is not an expiry: no event
events.length = 0;
const fresh = row(now - 1000);
assert.equal(needsInputAttention(fresh), false);
trackDisplayHint({ ...fresh, display_activity_hint: null });
await tick();
assert.deepEqual(events, [], 'a hint taken away by a feed is not an expiry');

Date.now = realNow;
console.log('display_hint_expiry: ok (the lease is noticed by whoever asks first, once; a feed that takes the hint away is not an expiry)');
process.exit(0); // the lease timers are real: the suite does not wait for them
