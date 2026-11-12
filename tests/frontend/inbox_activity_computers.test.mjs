// The Activity folder across computers (#15380, A): every online computer's record is read on its own, rows keep their computer and never collide on id, a computer that fails or refuses does not fail the folder, each computer
// has its own cursor, and forget() clears it all. jsdom, no browser: node inbox_activity_computers.test.mjs
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const dom = new JSDOM('<!doctype html><body><script id="coral-boot" type="application/json">{"mode":"local"}</script></body>', { url: 'http://127.0.0.1:8420/' });
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'sessionStorage', 'getComputedStyle', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'AbortController']) {
    Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
const asked = [];
let plan = {};
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'http://127.0.0.1:8420');
    const m = /^\/api\/remote\/([^/]+)(\/api\/activity)$/.exec(u.pathname);
    const server = m ? m[1] : u.pathname === '/api/activity' ? 'local' : null;
    assert.ok(server, `an unexpected request: ${u.pathname}`);
    const p = plan[server] || {};
    asked.push({ server, before: u.searchParams.get('before') });
    if (p.status === 403) return json({ error: 'owner_only' }, 403);
    if (p.status && p.status !== 200) return json({ error: 'boom' }, p.status);
    const before = u.searchParams.get('before');
    const all = p.ids || [];
    const got = all.filter(a => before == null || a.id < Number(before)).slice(0, Number(u.searchParams.get('limit')));
    return json({ actions: got.map(a => ({ id: a.id, team: 'team', at: a.at, action: 'approved', item_kind: 'file', item_id: a.item_id || 'x', source: 'local' })), check: p.check || { intact: true, rows: all.length, note: '' } });
};
const { state } = await import(pathToFileURL(path.join(dir, 'state.js')).href);
const AC = await import(pathToFileURL(path.join(dir, 'inbox_activity.js')).href);
const online = ids => ids.map(id => ({ id, label: id.toUpperCase(), status: 'online' }));
const reset = (servers, p) => { asked.length = 0; plan = p; state.hub = !!servers; state.servers = servers; AC.forget(); };
const at = n => new Date(Date.UTC(2026, 10, 10, 12, n)).toISOString();
const filt = () => AC.filtered({ q: '', team: '', agent: '', goal: '', decision: '', action: '', from: '', order: 'newest' });

// this computer alone: read as it always was (one request, no server on the rows)
reset(undefined, { local: { ids: [{ id: 1, at: at(1) }] } });
await AC.refresh();
assert.deepEqual(asked.map(a => a.server), ['local']);
assert.equal(AC.total(), 1);

// two computers with the same ids: both are read, rows keep their computer, keys never collide, newest first across them
reset(online(['srv1', 'srv2']), { local: { ids: [{ id: 1, at: at(5) }] }, srv1: { ids: [{ id: 1, at: at(4) }, { id: 2, at: at(1) }] }, srv2: { ids: [{ id: 1, at: at(3) }] } });
await AC.refresh();
assert.deepEqual(asked.map(a => a.server).sort(), ['local', 'srv1', 'srv2']);
assert.equal(AC.total(), 4, 'ids repeat on each computer: nothing is dropped as a duplicate');
const rows = filt();
assert.deepEqual(rows.map(AC.keyOf).sort(), ['1', 'srv1/1', 'srv1/2', 'srv2/1'].sort());
assert.deepEqual(rows.map(r => r.at), [at(5), at(4), at(3), at(1)], 'merged by time, newest first');
assert.deepEqual(rows.map(r => r.team).sort(), ['@srv1/team', '@srv1/team', '@srv2/team', 'team'], 'a remote team is qualified by the Hub\'s own id for the computer');

// one computer fails, one is a grantee (403): the folder still shows the rest, and says which could not be read
reset(online(['srv1', 'srv2', 'srv3']), { local: { ids: [{ id: 1, at: at(5) }] }, srv1: { status: 500 }, srv2: { status: 403 }, srv3: { ids: [{ id: 7, at: at(2) }] } });
await AC.refresh();
assert.equal(AC.total(), 2);
// #15730: the computers that are not in the folder are NAMED with why, never left out silently: the failed one, the refused one (an older Coral, or a guest) and one that is offline (never asked)
assert.deepEqual(AC.missingComputers().map(m => m.id).sort(), ['srv1', 'srv2']);
assert.match(AC.missingWords(AC.missingComputers()), /SRV1 \(could not be read\)/);
assert.match(AC.missingWords(AC.missingComputers()), /SRV2 \(refused to give its record: an older Coral may need an update\)/);
reset([...online(['srv1', 'srv2']), { id: 'srv3', label: 'SRV3', status: 'offline' }], { local: { ids: [{ id: 1, at: at(5) }] }, srv1: { ids: [{ id: 3, at: at(4) }] }, srv2: { ids: [{ id: 4, at: at(3) }] } });
await AC.refresh();
assert.deepEqual(asked.map(a => a.server).sort(), ['local', 'srv1', 'srv2'], 'an offline computer is not asked');
assert.equal(AC.total(), 3);
assert.deepEqual(AC.missingComputers(), [{ id: 'srv3', why: 'is offline' }], 'an offline computer is named as missing');
assert.equal(AC.missingWords(AC.missingComputers()), 'Not in this list: SRV3 (is offline).');
// each row's From names its computer, and the Computer filter keeps one computer's rows
assert.deepEqual(filt().map(r => AC.fromCell(r)).sort(), ['SRV1', 'SRV2', 'This computer']);
const AFm = await import(pathToFileURL(path.join(dir, 'operator_activity_filters.js')).href);
assert.deepEqual(AC.filtered({ q: '', team: '', server: 'srv1', agent: '', goal: '', decision: '', action: '', from: '', order: 'newest' }).map(AC.keyOf), ['srv1/3'], 'the Computer filter keeps one computer');
assert.deepEqual(AC.filtered({ q: '', team: '', server: 'local', agent: '', goal: '', decision: '', action: '', from: '', order: 'newest' }).map(AC.keyOf), ['1'], 'and this computer is its own');
assert.equal(AFm.chips({ ...AFm.EMPTY, server: 'srv1' }).length, 1, 'a chip says which computer');

// every computer refuses 403: denied, as one computer always was; every one failing: failed
reset(online(['srv1']), { local: { status: 403 }, srv1: { status: 403 } });
await AC.refresh();
assert.equal(AC.total(), 0);

// older actions: each computer has its own cursor (its own smallest id), never another's
const many = (from, n, t0) => Array.from({ length: n }, (_, i) => ({ id: from - i, at: at(t0 + i) }));
reset(online(['srv1']), { local: { ids: many(1000, 200, 0) }, srv1: { ids: [{ id: 5000, at: at(1) }] } });
await AC.refresh();
assert.equal(AC.total(), 201);
asked.length = 0;
await AC.refresh(null, { next: true });
assert.deepEqual(asked.map(a => `${a.server}:${a.before}`), ['local:801'], 'only the computer with more is asked, with its own cursor');

// a computer that leaves the list takes its actions along, even for a page of older ones (#15404)
reset(online(['srv1', 'srv2']), { local: { ids: [{ id: 1, at: at(1) }] }, srv1: { ids: [{ id: 1, at: at(2) }] }, srv2: { ids: [{ id: 1, at: at(3) }] } });
await AC.refresh();
assert.equal(AC.total(), 3);
state.servers = online(['srv1']);
await AC.refresh(null, { next: true });
assert.deepEqual(filt().map(AC.keyOf).sort(), ['1', 'srv1/1'], 'srv2 is gone from the list: its rows are not shown');

// a remote file's row opens on ITS computer: the open callback gets the row with its qualified team, which is what the sidebar reads the computer from (Security INFO #15405, #15427)
const { splitKey } = await import(pathToFileURL(path.join(dir, 'server_base.js')).href);
const digest = 'ab'.repeat(32);
reset(online(['srv1']), { local: { ids: [] }, srv1: { ids: [{ id: 9, at: at(4), item_id: digest }] } });
await AC.refresh();
const opened = [];
const table = AC.spec(filt(), { file: r => opened.push(r), goal() {}, question() {}, task() {}, agent() {}, message() {}, chat() {}, workflow() {}, job() {} }).node();
document.body.append(table);
const btn = table.querySelector('button.dt-primary');
assert.ok(btn, 'the row has a button that opens its file');
btn.click();
assert.equal(opened.length, 1, 'clicking the remote file row opens it once');
assert.equal(opened[0].server, 'srv1');
assert.equal(splitKey(opened[0].team).server, 'srv1', 'the sidebar takes the computer from the team, so it is the row\'s own computer, never this one');
assert.equal(opened[0].item_id, digest);

// a sign-out clears it all (the page's own event, not only a call)
document.dispatchEvent(new window.CustomEvent('coral:signed-out'));
assert.equal(AC.total(), 0, 'coral:signed-out forgets');

// forget clears everything
AC.forget();
assert.equal(AC.total(), 0);
console.log('ok inbox_activity_computers');
