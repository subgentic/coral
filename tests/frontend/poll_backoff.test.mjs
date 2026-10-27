// The idle poll's schedule (#9101): 1 s for the first polls, then 2, 4, 8 and at most 10 s; the agent page's chat poll asks fewer times while it hears nothing.
import assert from 'node:assert/strict';
import { ticksAfter, QUICK_POLLS, MAX_WAIT_FACTOR, WAKE_EVENTS, backoffTicker } from '../../coral-go/pkg/frontend/static/poll_backoff.js';

assert.deepEqual([0, 1, 2, 3].map(ticksAfter), [1, 1, 1, 1], 'the first polls keep the base rate');
assert.deepEqual([4, 5, 6, 7, 8, 50].map(ticksAfter), [2, 4, 8, 10, 10, 10], 'then it doubles up to the cap');
assert.equal(QUICK_POLLS, 3); assert.equal(MAX_WAIT_FACTOR, 10);
// 30 one-second ticks of nothing: the number of polls made, the way live_history.js counts them
function polls(ticks) { let idle = 0, wait = 0, made = 0; for (let t = 0; t < ticks; t++) { if (--wait > 0) continue; made++; idle++; wait = ticksAfter(idle); } return made; }
assert.ok(polls(30) <= 10, 'at most 10 polls in 30 s of silence (it was 30): ' + polls(30));
assert.ok(polls(300) <= 40, 'a quiet agent page polls about every 10 s in the long run: ' + polls(300));
// the ticker: backed off after silence, and every wake event (the tab becoming visible among them, #9124) puts it back to every tick
for (const ev of WAKE_EVENTS) {
    const target = new EventTarget(); let reads = 0;
    const t = backoffTicker(target, async () => { reads++; return false; });
    for (let i = 0; i < 30; i++) await t.tick(); // 30 ticks of silence: backed off
    const quiet = reads;
    assert.ok(quiet < 12, `${ev}: backed off (${quiet} reads in 30 ticks)`);
    await t.tick(); await t.tick(); assert.ok(reads - quiet <= 1, `${ev}: still waiting just before the event`);
    target.dispatchEvent(new Event(ev));
    const before = reads;
    await t.tick(); await t.tick(); await t.tick();
    assert.equal(reads - before, 3, `${ev} wakes the poll: every tick reads again`);
    t.stop(); target.dispatchEvent(new Event(ev));
}
assert.ok(WAKE_EVENTS.includes('visibilitychange'), 'the tab becoming visible wakes the poll');
console.log('PASS poll backoff: 1 s, then 2, 4, 8, 10 s; ' + polls(30) + ' polls in 30 s of silence instead of 30');
