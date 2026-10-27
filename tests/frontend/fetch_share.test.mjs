// fetch_share.js (#9111): the same read asked twice at load is one request. Request counts are what this pins: the #9090 audit saw cloud/status, sessions/live,
// board/projects, a board's status and goals fetched two or three times on every screen.
import assert from 'node:assert/strict';

let calls = [], clock = 0, fail = false, status = 200;
globalThis.location = new URL('https://coral.test/');
globalThis.window = { fetch: async (input, init) => { const url = String(input && input.url || input); calls.push(`${(init && init.method) || 'GET'} ${url}`); if (fail) throw new TypeError('down'); await new Promise(r => setTimeout(r, 5)); return new Response(JSON.stringify({ n: calls.length }), { status }); } };
const { installFetchShare } = await import('../../coral-go/pkg/frontend/static/fetch_share.js');
installFetchShare(() => clock);
const get = (u, init) => window.fetch(u, init);
const n = () => calls.length;

// two callers in flight: one request, each reads its own body
let [a, b] = await Promise.all([get('/api/cloud/status'), get('/api/cloud/status')]);
assert.equal(n(), 1, 'two reads in flight are one request');
assert.deepEqual(await a.json(), await b.json(), 'each caller has its own copy of the body');
// a third after it answered, within a second
clock += 600; await (await get('/api/cloud/status')).json();
assert.equal(n(), 1, 'within a second of the answer: the same answer');
clock += 500; await get('/api/cloud/status');
assert.equal(n(), 2, 'a second after it answered: asked again');

// the load's repeats: each named read once, with its query
calls = []; clock = 10000;
await Promise.all(['/api/sessions/live', '/api/sessions/live', '/api/board/projects', '/api/board/projects', '/api/board/alpha/status', '/api/board/alpha/status', '/api/board/alpha/status',
    '/api/board/alpha/goals?state=active&limit=200', '/api/board/alpha/goals?state=active&limit=200', '/api/teams/detail/alpha/knowledge', '/api/teams/detail/alpha/knowledge', '/api/workflows', '/api/workflows',
    '/api/system/status', '/api/system/status', '/api/system/artifact-store', '/api/system/artifact-store'].map(u => get(u)));
assert.equal(n(), 8, 'seventeen reads of eight routes are eight requests: ' + calls.join(', '));
// a different query or a different board is its own request
calls = []; clock += 5000;
await Promise.all([get('/api/board/alpha/status'), get('/api/board/beta/status'), get('/api/board/alpha/goals?limit=1'), get('/api/board/alpha/goals?limit=2')]);
assert.equal(n(), 4, 'a board, or a query, of its own');

// a write forgets: the read after it is a new one
calls = []; clock += 5000;
await get('/api/board/alpha/status'); await get('/api/board/alpha/tasks', { method: 'POST' }); await get('/api/board/alpha/status');
assert.equal(n(), 3, 'a POST to /api between two reads: the second read is asked: ' + calls.join(', '));

// never shared: a read with an abort signal, a read of another route, another origin, a read with headers
calls = []; clock += 5000;
await Promise.all([get('/api/board/alpha/status', { signal: new AbortController().signal }), get('/api/board/alpha/status', { signal: new AbortController().signal }), get('/api/sessions/history'), get('/api/sessions/history'),
    get('https://other.test/api/cloud/status'), get('https://other.test/api/cloud/status'), get('/api/cloud/status', { headers: { a: 'b' } }), get('/api/cloud/status', { headers: { a: 'b' } })]);
assert.equal(n(), 8, 'a signal, an unnamed route, another origin and a header each go through: ' + calls.join(', '));

// a failure is not kept: 500 and a network error are asked again
calls = []; clock += 5000; status = 500;
await get('/api/system/status'); await get('/api/system/status');
assert.equal(n(), 2, 'a 500 is not shared after it answered');
status = 200; fail = true; calls = []; clock += 5000;
await Promise.allSettled([get('/api/system/status'), get('/api/system/status')]); await get('/api/system/status').catch(() => {});
assert.equal(n(), 2, 'a network error is shared while in flight, and not kept: ' + calls.join(', '));

// a module instance of its own over a stub of its own, for the cases that need a different stub
let instance = 0;
async function over(stub, clockFn = () => clock) {
    window.fetch = stub;
    const m = await import(`../../coral-go/pkg/frontend/static/fetch_share.js?i=${++instance}`);
    m.installFetchShare(clockFn);
}

// the Security Reviewer's probe: a write takes 50 ms; a poll at 10 ms gets the old state; after the write the UI's own read must be the new state
let state = 'old';
await over(async (input, init) => {
    const method = (init && init.method) || 'GET';
    if (method === 'POST') { await new Promise(r => setTimeout(r, 50)); state = 'new'; return new Response('{}'); }
    const seen = state; await new Promise(r => setTimeout(r, 5)); return new Response(JSON.stringify({ state: seen }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const write = window.fetch('/api/board/alpha/tasks', { method: 'POST' });
await sleep(10);
const poll = await (await window.fetch('/api/board/alpha/status')).json(); // made while the write is in flight, and answered before it lands
assert.equal(poll.state, 'old');
await write;
await sleep(100);
assert.equal((await (await window.fetch('/api/board/alpha/status')).json()).state, 'new', 'a read after the write is the state after it, not the poll made while it ran');
// two reads while a write is in flight are two requests: nothing is shared with a read made during a write
let during = 0;
await over(async (input, init) => { if (init && init.method === 'POST') { await sleep(40); return new Response('{}'); } during++; return new Response('{}'); });
const w2 = window.fetch('/api/board/alpha/tasks', { method: 'POST' });
await Promise.all([window.fetch('/api/board/alpha/status'), window.fetch('/api/board/alpha/status')]);
assert.equal(during, 2, 'no read is shared while a write is in flight');
await w2;
// a failed write forgets too
await over(async (input, init) => { if (init && init.method === 'POST') throw new TypeError('down'); return new Response(JSON.stringify({ state })); });
state = 'a'; await (await window.fetch('/api/board/alpha/status')).json();
state = 'b'; await window.fetch('/api/board/alpha/tasks', { method: 'POST' }).catch(() => {});
assert.equal((await (await window.fetch('/api/board/alpha/status')).json()).state, 'b', 'a write that failed also forgets');

// a caller that asks for a fresh read is given one: cache, credentials, mode..., and a Request object
let hits = 0;
await over(async () => { hits++; return new Response('{}'); });
for (const init of [{ cache: 'no-store' }, { credentials: 'same-origin' }, { mode: 'same-origin' }, { referrer: '' }, { redirect: 'error' }, { headers: { a: 'b' } }]) {
    hits = 0; clock += 5000;
    await Promise.all([window.fetch('/api/system/status', init), window.fetch('/api/system/status', init)]);
    assert.equal(hits, 2, 'two reads with ' + JSON.stringify(init) + ' are two requests');
}
hits = 0; clock += 5000;
await Promise.all([window.fetch(new Request('https://coral.test/api/system/status')), window.fetch(new Request('https://coral.test/api/system/status'))]);
assert.equal(hits, 2, 'a Request object is its own request');
hits = 0; clock += 5000;
await Promise.all([window.fetch('/api/system/status'), window.fetch('/api/system/status')]);
assert.equal(hits, 1, 'and a plain read is still shared');

// #9167: a person's own input is a refresh: no read is shared within two seconds of it, and what was kept is forgotten
globalThis.document = new EventTarget();
await over(async () => { hits++; return new Response('{}'); });
hits = 0; clock += 5000;
await window.fetch('/api/scheduled/jobs'); document.dispatchEvent(new Event('click'));
await window.fetch('/api/scheduled/jobs');
assert.equal(hits, 2, 'a click forgets the read kept from before it: Refresh reads fresh');
hits = 0; clock += 500;
await Promise.all([window.fetch('/api/workflows'), window.fetch('/api/workflows')]);
assert.equal(hits, 2, 'within two seconds of the click, two reads are two requests');
for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    clock += 5000; hits = 0; document.dispatchEvent(new Event(type));
    await Promise.all([window.fetch('/api/system/status'), window.fetch('/api/system/status')]);
    assert.equal(hits, 2, type + ' is input too');
}
hits = 0; clock += 2500;
await Promise.all([window.fetch('/api/workflows'), window.fetch('/api/workflows')]);
assert.equal(hits, 1, 'two seconds after the input the page\'s own reads are shared again');
delete globalThis.document;

// a hub-proxied route and the plain one are never shared
hits = 0; clock += 5000;
await Promise.all([window.fetch('/api/sessions/live'), window.fetch('/api/remote/box-2/api/sessions/live'), window.fetch('/api/remote/box-2/api/sessions/live'), window.fetch('/api/remote/box-3/api/sessions/live')]);
assert.equal(hits, 4, 'the plain read and each hub-proxied read are their own requests (the patterns are anchored)');
console.log('fetch_share: ok');
