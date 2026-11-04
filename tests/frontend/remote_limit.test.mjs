// remote_limit.js (#13304): through Coral Hub one computer allows 8 requests in flight and 503s the rest at once. A page that asks for more must wait its turn, and a read that was refused is asked again.
import assert from 'node:assert/strict';

globalThis.location = new URL('https://hub.test/');
let inFlight = {}, peak = {}, seen503 = 0, calls = [];
let hubCap = 8;
globalThis.window = { fetch: async (input, init) => {
    const url = new URL(String(input && input.url || input), location.href), m = /^\/api\/remote\/([^/]+)\//.exec(url.pathname);
    const key = m ? m[1] : 'local', method = String((init && init.method) || 'GET').toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    inFlight[key] = (inFlight[key] || 0) + 1; peak[key] = Math.max(peak[key] || 0, inFlight[key]);
    try {
        if (m && (inFlight[key] > hubCap)) { seen503++; return new Response('{}', { status: 503, headers: { 'Retry-After': '1' } }); }
        await new Promise(r => setTimeout(r, 5)); // sleep-ok: a request that takes a moment
        return new Response('{"ok":true}', { status: 200 });
    } finally { inFlight[key]--; }
} };
const rl = await import('../../coral-go/pkg/frontend/static/remote_limit.js');
const slept = [];
rl.remoteLimitHooks.sleep = async ms => { slept.push(ms); };
rl.remoteLimitHooks.rand = () => 0;
const reset = () => { inFlight = {}; peak = {}; seen503 = 0; calls = []; slept.length = 0; };

// the control: without the limit, 40 reads at once go over the Hub's 8 and some are 503
const bare = window.fetch;
const statuses = async f => (await Promise.all(Array.from({ length: 40 }, (_, i) => f(`/api/remote/ws1/api/board/t${i}/status`)))).map(r => r.status);
let s = await statuses(bare);
assert.ok(s.includes(503) && seen503 > 0, 'without the limit the page goes over the Hub cap: ' + seen503 + ' 503s');

// with it: 40 reads at once, none over 6 in flight, none refused, all 200
reset();
rl.installRemoteLimit();
const limitedFetch = window.fetch;
assert.notEqual(limitedFetch, bare, 'fetch is wrapped');
s = await statuses(limitedFetch);
assert.ok(s.every(x => x === 200), 'every read answered 200: ' + [...new Set(s)]);
assert.equal(seen503, 0, 'the Hub refused none');
assert.ok(peak.ws1 <= rl.MAX_IN_FLIGHT && peak.ws1 >= 2, 'at most 6 in flight, and they did run together: ' + peak.ws1);
assert.equal(calls.length, 40, 'each read was sent once');

// another computer is not held up by a full one, and Coral's own requests are not limited
reset();
hubCap = 100;
let release; const gate = new Promise(r => { release = r; });
rl.installRemoteLimit();
assert.equal(window.fetch, limitedFetch, 'installing twice wraps once');
const heldFetch = async () => { await gate; return new Response('{}', { status: 200 }); };
const six = Array.from({ length: 7 }, () => rl.limited('lane-a', 'GET', null, heldFetch));
let seventhStarted = false;
const probe = rl.limited('lane-b', 'GET', null, async () => { seventhStarted = true; return new Response('{}', { status: 200 }); });
await probe;
assert.ok(seventhStarted, 'a request for another computer ran while another was full (7 asked, 6 allowed)');
release(); await Promise.all(six);

// a read the Hub turned away is asked again after its Retry-After, and the caller sees the answer
reset(); hubCap = 8; 
let n = 0;
const flaky = async () => (++n < 3 ? new Response('{}', { status: 503, headers: { 'Retry-After': '2' } }) : new Response('{"ok":true}', { status: 200 }));
let r = await rl.limited('ws2', 'GET', null, flaky);
assert.equal(r.status, 200, 'two refusals, then the answer');
assert.deepEqual(slept, [2000, 2000], 'it waited what the Hub said, twice');

// still busy after the retries: the 503 is the answer (the overload pause then applies), after 3 sends
reset(); n = 0;
r = await rl.limited('ws2', 'GET', null, async () => { n++; return new Response('{}', { status: 503 }); });
assert.equal(r.status, 503);
assert.equal(n, 1 + rl.RETRIES, 'one send and two retries');
assert.deepEqual(slept, [1000, 1000], 'with no Retry-After: a second');
reset(); r = await rl.limited('ws2', 'GET', null, async () => new Response('{}', { status: 503, headers: { 'Retry-After': '900' } }));
assert.ok(slept.length === 2 && slept.every(x => x === 5000), 'a long Retry-After is cut at 5 s: ' + slept);

// a write is never asked again
reset(); n = 0;
r = await rl.limited('ws2', 'POST', null, async () => { n++; return new Response('{}', { status: 503 }); });
assert.equal(r.status, 503); assert.equal(n, 1, 'a POST refused is not repeated'); assert.equal(slept.length, 0);

// aborted while waiting: it never starts
reset();
const hold = Array.from({ length: rl.MAX_IN_FLIGHT }, () => rl.limited('ws3', 'GET', null, heldFetch));
const ac = new AbortController();
let started = false;
const waiting = rl.limited('ws3', 'GET', ac.signal, async () => { started = true; return new Response('{}'); });
ac.abort();
await assert.rejects(waiting, e => e.name === 'AbortError');
assert.equal(started, false, 'an aborted request that waited for its turn is never sent');
await Promise.all(hold);
// a slot is held for at most remoteLimitHooks.holdMs (30 s): six requests that hang through the Hub do not block the computer's lane until reload (#13351, Security's INFO on #13304); the hung requests go on, only their slots are given back
reset(); hubCap = 100;
rl.remoteLimitHooks.holdMs = 25; // the seam: a test does not wait 30 s
const hang = () => new Promise(() => {}); // never answers
const hung = Array.from({ length: rl.MAX_IN_FLIGHT }, () => rl.limited('lane-hung', 'GET', null, hang));
let seventh = false;
const seventhReq = rl.limited('lane-hung', 'GET', null, async () => { seventh = true; return new Response('{}', { status: 200 }); });
const early = await Promise.race([seventhReq.then(() => 'started'), new Promise(r => setTimeout(() => r('blocked'), 5))]); // sleep-ok: the seventh must NOT start before a slot is given back
assert.equal(early, 'blocked', 'while six hang inside their hold the seventh waits its turn');
const later = await Promise.race([seventhReq.then(() => 'started'), new Promise(r => setTimeout(() => r('blocked'), 400))]); // sleep-ok: well past the hold
assert.equal(later, 'started', 'after the hold the six slots are given back and a seventh request starts: ' + later);
assert.ok(seventh, 'the seventh request was sent');
// a slot is given back once: a request that answers within its hold frees its slot at that moment, and its timer does not free a second slot later
rl.remoteLimitHooks.holdMs = 30;
reset();
let running = 0, peakRunning = 0;
const tracked = () => new Promise(res => { running++; peakRunning = Math.max(peakRunning, running); setTimeout(() => { running--; res(new Response('{}', { status: 200 })); }, 5); }); // sleep-ok: a request that takes a moment
await Promise.all(Array.from({ length: 20 }, () => rl.limited('lane-once', 'GET', null, tracked)));
await new Promise(r => setTimeout(r, 60)); // sleep-ok: past every hold timer
assert.ok(peakRunning <= rl.MAX_IN_FLIGHT, 'answered requests free their slot once: at most 6 ran together, saw ' + peakRunning);
rl.remoteLimitHooks.holdMs = 30000;

// the slot is given back ONCE (#13360, QA's SHOULD on #13351): six requests hang, the hold passes, the seventh starts, then the six answer late. Their late answers must not give back slots they no longer hold: with the
// freed flag removed each late answer released a second slot, so more than 6 ran at once afterwards.
reset(); hubCap = 100;
rl.remoteLimitHooks.holdMs = 20;
let live = 0, peakLive = 0;
const enter = () => { live++; peakLive = Math.max(peakLive, live); };
const answers = [];
const hangThenAnswer = () => new Promise(res => { enter(); answers.push(() => { live--; res(new Response('{}', { status: 200 })); }); });
const sixHung = Array.from({ length: rl.MAX_IN_FLIGHT }, () => rl.limited('lane-late', 'GET', null, hangThenAnswer));
const seventhDone = rl.limited('lane-late', 'GET', null, async () => { enter(); await new Promise(r => setTimeout(r, 5)); live--; return new Response('{}', { status: 200 }); }); // sleep-ok: a request that takes a moment
await seventhDone; // it started once the hold gave a slot back, and it finished
for (const answer of answers) answer(); // the six answer late, after their hold
await Promise.all(sixHung);
// a burst after the late answers: if each late answer had freed a second slot the lane would now allow 12 together
const burst = await Promise.all(Array.from({ length: 24 }, () => rl.limited('lane-late', 'GET', null, async () => { enter(); await new Promise(r => setTimeout(r, 5)); live--; return new Response('{}', { status: 200 }); }))); // sleep-ok: a request that takes a moment
assert.ok(burst.every(x => x.status === 200), 'the burst was answered');
assert.ok(peakLive <= rl.MAX_IN_FLIGHT + 1, 'in flight never goes past the 6 slots plus the one request that took a given-back slot: ' + peakLive);
const afterLate = (() => { let l = 0, p = 0; return { start: () => { l++; p = Math.max(p, l); }, end: () => { l--; }, peak: () => p }; })();
await Promise.all(Array.from({ length: 24 }, () => rl.limited('lane-late', 'GET', null, async () => { afterLate.start(); await new Promise(r => setTimeout(r, 5)); afterLate.end(); return new Response('{}', { status: 200 }); }))); // sleep-ok: a request that takes a moment
assert.ok(afterLate.peak() <= rl.MAX_IN_FLIGHT, 'after the late answers the lane still allows 6 at once, not 12: ' + afterLate.peak());
rl.remoteLimitHooks.holdMs = 30000;

// ── #13379, the #13304 review's SHOULDs: four behaviours no test pinned ──────────────────────────────────────────────────────────────────────────────────────────────
const within = (promise, ms) => Promise.race([promise.then(() => 'done', () => 'done'), new Promise(r => setTimeout(() => r('stuck'), ms))]); // sleep-ok: a request that must NOT be stuck
const peakOf = async (n, laneName, sendOf) => { let live = 0, peak = 0; await Promise.all(Array.from({ length: n }, () => rl.limited(laneName, 'GET', null, async () => { live++; peak = Math.max(peak, live); try { return await sendOf(); } finally { live--; } }))); return peak; };

// (a) a send that throws gives its slot back: six network errors must not stall that computer's reads
reset(); hubCap = 100; rl.remoteLimitHooks.holdMs = 30000; // the hold timer is not what frees them here
const failing = Array.from({ length: rl.MAX_IN_FLIGHT + 2 }, () => rl.limited('lane-err', 'GET', null, async () => { throw new TypeError('network error'); }));
const settledAll = Promise.allSettled(failing);
assert.equal(await within(settledAll, 500), 'done', 'eight network errors in a row all settle: a failed send gives its slot back (with six leaked slots the seventh and eighth would wait forever)');
const errs = await settledAll;
assert.ok(errs.every(e => e.status === 'rejected' && e.reason instanceof TypeError), 'each network error reaches its caller, not swallowed');
assert.equal(await within(rl.limited('lane-err', 'GET', null, async () => new Response('{}', { status: 200 })), 300), 'done', 'after six network errors a read on that computer still runs: the failed sends gave their slots back');
assert.equal(await peakOf(rl.MAX_IN_FLIGHT, 'lane-err', () => new Promise(r => setTimeout(() => r(new Response('{}')), 10))), rl.MAX_IN_FLIGHT, 'and the lane still allows all 6 at once'); // sleep-ok: a request that takes a moment

// (b) only a 503 is retried: other answers, 5xx included, are the answer on the first send
for (const status of [500, 502, 504, 429, 404]) {
    reset(); n = 0;
    r = await rl.limited('lane-status', 'GET', null, async () => { n++; return new Response('{}', { status }); });
    assert.equal(r.status, status); assert.equal(n, 1, `a ${status} is not asked again`); assert.equal(slept.length, 0, `and nothing waited for a ${status}`);
}

// (c) an aborted request leaves the queue
// c1: already aborted before it is queued: it rejects, is never sent and takes no slot
reset();
const gone = new AbortController(); gone.abort();
let sentAborted = false;
await assert.rejects(rl.limited('lane-abort', 'GET', gone.signal, async () => { sentAborted = true; return new Response('{}'); }), e => e.name === 'AbortError');
assert.equal(sentAborted, false, 'a request aborted before it was queued is never sent');
assert.equal(await peakOf(rl.MAX_IN_FLIGHT, 'lane-abort', () => new Promise(r => setTimeout(() => r(new Response('{}')), 10))), rl.MAX_IN_FLIGHT, 'and it took no slot: all 6 still run together'); // sleep-ok: a request that takes a moment
// c2: aborted while it waits for its turn: its place in the queue goes with it, so when the others finish the lane is whole again
reset();
let freeSix; const gateSix = new Promise(res => { freeSix = res; });
const sixHeld = Array.from({ length: rl.MAX_IN_FLIGHT }, () => rl.limited('lane-queue', 'GET', null, async () => { await gateSix; return new Response('{}'); }));
const quitter = new AbortController();
const quit = rl.limited('lane-queue', 'GET', quitter.signal, async () => new Response('{}'));
quitter.abort();
await assert.rejects(quit, e => e.name === 'AbortError');
freeSix(); await Promise.all(sixHeld);
assert.equal(await peakOf(rl.MAX_IN_FLIGHT, 'lane-queue', () => new Promise(r => setTimeout(() => r(new Response('{}')), 10))), rl.MAX_IN_FLIGHT, 'the aborted waiter left no hole in the lane: all 6 run together again'); // sleep-ok: a request that takes a moment
// c3: aborted during the retry wait after a 503: AbortError, and no second send
reset(); n = 0;
const midWait = new AbortController();
rl.remoteLimitHooks.sleep = async ms => { slept.push(ms); midWait.abort(); }; // the person leaves while the retry waits
await assert.rejects(rl.limited('lane-wait', 'GET', midWait.signal, async () => { n++; return new Response('{}', { status: 503 }); }), e => e.name === 'AbortError');
assert.equal(n, 1, 'aborted during the retry wait: it is not sent again');
rl.remoteLimitHooks.sleep = async ms => { slept.push(ms); };

// (d) the same-origin check: only requests to this page's own origin are limited; another origin's /api/remote/ path is none of this limiter's
reset(); hubCap = 100;
reset(); await Promise.all(Array.from({ length: 10 }, () => window.fetch('/api/remote/ws-own/api/x'))); const own = peak['ws-own'];
reset(); await Promise.all(Array.from({ length: 10 }, () => window.fetch('https://elsewhere.test/api/remote/ws-other/api/x'))); const other = peak['ws-other'];
assert.ok(own <= rl.MAX_IN_FLIGHT, 'this page\'s own /api/remote requests are limited: ' + own);
assert.equal(other, 10, 'another origin\'s are passed straight through, not limited: ' + other);

console.log('remote_limit: ok');
