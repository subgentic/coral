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
console.log('fetch_share: ok');
