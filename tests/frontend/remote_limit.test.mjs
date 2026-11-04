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
console.log('remote_limit: ok');
