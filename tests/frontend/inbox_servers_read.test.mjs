// readInboxArtifacts (#12672, coral-hub's beta pass): one computer failing does not fail the folder, the answer says how many computers its count is a sum of and which failed, a computer that counts every
// version is named, the "list of computers not loaded" and "no computer online" cases are said and never an empty list, and the versions fallback stays 400-only (a 404 is a route that is not there, which asking
// again without the key cannot fix). A Hub-served page (mode cloud: no local computer). jsdom, no browser: node inbox_servers_read.test.mjs
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const dom = new JSDOM('<!doctype html><body><script id="coral-boot" type="application/json">{"mode":"cloud"}</script></body>', { url: 'http://127.0.0.1:8420/' });
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'sessionStorage', 'getComputedStyle', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'AbortController']) {
    Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
const asked = [];
let plan = {};
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1:8420');
    const m = /^\/api\/remote\/([^/]+)\/api\/team-artifacts$/.exec(u.pathname);
    assert.ok(m, `an unexpected request: ${u.pathname}`);
    const server = m[1], p = plan[server] || {};
    asked.push(server + (u.searchParams.has('versions') ? '+v' : ''));
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (p.versionsBad && u.searchParams.has('versions')) return json({ error: 'unknown' }, p.versionsBad);
    if (p.ownerOnly) return json({ error: 'owner_only', code: 'owner_only' }, 403);
    if (p.status && p.status !== 200) return json({ error: 'boom' }, p.status);
    const rows = Array.from({ length: p.rows || 0 }, (_, i) => ({ id: server + i, name: `${server}-${i}.md`, board_id: 'team' }));
    return json({ artifacts: rows, teams: [], total: rows.length, all: p.all ?? rows.length, has_more: false });
};
const { state } = await import(pathToFileURL(path.join(dir, 'state.js')).href);
const { readInboxArtifacts } = await import(pathToFileURL(path.join(dir, 'inbox_servers.js')).href);
const reset = (servers, p) => { asked.length = 0; plan = p; state.hub = true; state.servers = servers; };
const online = ids => ids.map(id => ({ id, label: id.toUpperCase(), status: 'online' }));
const read = (filters = {}) => readInboxArtifacts(new URLSearchParams({ limit: '100', versions: 'newest' }), filters);

// the list of computers has not loaded: not an answer about artifacts
reset(undefined, {});
let d = await read();
assert.equal(d.waiting, true, 'servers not loaded: the read is not finished');
assert.deepEqual(d.artifacts, []);
assert.equal(asked.length, 0, 'nobody was asked');

// no computer online: it throws, it does not return an empty list
reset([{ id: 'srv1', label: 'SRV1', status: 'offline' }], {});
await assert.rejects(read(), /No linked computer is online/);

// one computer fails: the others answer, the failing one is named, the count is of the two that answered
reset(online(['srv1', 'srv2', 'srv3']), { srv1: { rows: 3, all: 500 }, srv2: { rows: 2, all: 113 }, srv3: { status: 500 } });
d = await read();
assert.equal(d.artifacts.length, 5, 'the rows of the computers that answered');
assert.equal(d.all, 613);
assert.deepEqual([d.answered, d.expected], [2, 3]);
assert.deepEqual(d.failed, ['srv3']);
assert.deepEqual(d.versionless, []);
assert.equal(d.has_more, false, 'a computer that failed is not "more": Retry reads the folder again');
const cursor = JSON.parse(d.next_cursor);
assert.equal(cursor.srv3.failed, true, 'it is kept as unread, not as done and empty');

// paging on after that does not ask the failed computer again and still names it
asked.length = 0;
const again = await readInboxArtifacts(new URLSearchParams({ limit: '100', versions: 'newest', cursor: d.next_cursor }), {});
assert.deepEqual(asked, [], 'every source is done or failed: nobody is asked');
assert.deepEqual(again.failed, ['srv3']);
assert.deepEqual([again.answered, again.expected], [2, 3]);

// every computer fails: it throws (the page shows the failure line)
reset(online(['srv1', 'srv2']), { srv1: { status: 500 }, srv2: { status: 502 } });
await assert.rejects(read(), /could not be read from SRV1, SRV2/);
reset(online(['srv1']), { srv1: { status: 500 } });
await assert.rejects(read(), /SRV1 artifacts could not be read \(500\)/);

// a computer that refused owner_only is not expected to answer: the sum is of the others, and nothing is "missing"
reset(online(['srv1', 'srv9']), { srv1: { rows: 1, all: 7 }, srv9: { ownerOnly: true } }); // (the module remembers an owner_only computer for the session, so it has an id of its own)
d = await read();
assert.deepEqual([d.answered, d.expected, d.failed], [1, 1, []]);

// versions: only a 400 is "this Coral does not know the key": it is asked again without it and named; a 404 is not retried
reset(online(['srv1', 'srv2']), { srv1: { rows: 2, all: 20809, versionsBad: 400 }, srv2: { rows: 1, all: 3 } });
d = await read();
assert.deepEqual(asked.sort(), ['srv1', 'srv1+v', 'srv2+v'], 'srv1 is asked again without the key');
assert.deepEqual(d.versionless, ['srv1'], 'its count is of every version of a file');
assert.deepEqual([d.answered, d.expected], [2, 2]);
reset(online(['srv1', 'srv2']), { srv1: { versionsBad: 404 }, srv2: { rows: 1, all: 3 } });
d = await read();
assert.deepEqual(asked.sort(), ['srv1+v', 'srv2+v'], 'a 404 is not asked again');
assert.deepEqual(d.failed, ['srv1']);
console.log('inbox_servers_read: ok');
