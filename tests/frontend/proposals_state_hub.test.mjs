// A team's goal proposal on another computer reaches the Operator's Needs you through a Hub (#13454): proposals_state read only this computer's /api/proposals, so on a Hub-served page (no local
// computer) and for a linked computer's teams there were never any rows. Each online computer is read on its own, one that refuses (a grantee there) or fails has no rows and does not blank the
// others, and a decision goes to the computer the proposal is on. jsdom, no browser: node proposals_state_hub.test.mjs
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
let srv1Refuses = false, srv3Fails = false;
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1:8420');
    asked.push(`${opts.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/api/remote/srv1/api/proposals' && srv1Refuses) return json({ error: 'owner_only' }, 403);
    if (u.pathname === '/api/remote/srv1/api/proposals') return json({ proposals: [{ id: 3, board_id: 'team', board_label: 'Team', kind: 'goal', title: 'Ship it', proposer: 'Dev', state: 'pending', created_at: '2026-11-04T10:00:00Z' }] });
    if (u.pathname === '/api/remote/srv2/api/proposals') return json({ error: 'owner_only' }, 403);
    if (u.pathname === '/api/remote/srv3/api/proposals' && srv3Fails) return json({ error: 'boom' }, 500);
    if (u.pathname === '/api/remote/srv3/api/proposals') return json({ proposals: [
        { id: 4, board_id: 'ops', kind: 'task', title: 'Old news', proposer: 'Dev', state: 'expired', created_at: '2026-10-01T10:00:00Z' },
        { id: 5, board_id: 'ops', kind: 'task', title: 'Fresh', proposer: 'Dev', state: 'pending', created_at: '2026-11-04T10:00:00Z' }] });
    if (u.pathname === '/api/remote/srv1/api/board/team/proposals/3/approve') return json({ created_id: 9 });
    assert.fail(`an unexpected request: ${u.pathname}`);
};
const { state } = await import(pathToFileURL(path.join(dir, 'state.js')).href);
const { refreshProposals, proposalItems, decide, dismissExpired } = await import(pathToFileURL(path.join(dir, 'proposals_state.js')).href);
state.hub = true;
state.servers = ['srv1', 'srv2', 'srv3', 'srv4'].map(id => ({ id, label: id.toUpperCase(), status: id === 'srv4' ? 'offline' : 'online' }));

await refreshProposals(true);
const rows = proposalItems();
assert.equal(rows.length, 3, `the proposals of srv1 and srv3 are listed (asked: ${asked.join(', ')})`);
const first = rows.find(r => r.id === 3);
assert.equal(first.server, 'srv1');
assert.equal(first.board_id, '@srv1/team', 'the team is named with its computer, as every other row of this page is');
assert.equal(first.rowKey, 'proposal:@srv1/team:3');
assert.ok(asked.includes('GET /api/remote/srv2/api/proposals') && asked.includes('GET /api/remote/srv3/api/proposals'), 'every online computer is asked');
assert.ok(!asked.some(a => a.includes('srv4')), 'an offline computer is not asked');
assert.ok(!asked.includes('GET /api/proposals'), 'a Hub-served page has no computer of its own to ask');

asked.length = 0;
const out = await decide(first, 'approve');
assert.equal(out.ok, true, out.text);
assert.ok(asked.includes('POST /api/remote/srv1/api/board/team/proposals/3/approve'), `the decision goes to the computer it is on (${asked.join(', ')})`);

// a computer that refuses now (the person is a grantee there) has no rows; a computer that fails keeps the rows it had
srv1Refuses = true; srv3Fails = true;
await refreshProposals(true);
assert.deepEqual(proposalItems().map(r => r.id).sort(), [4, 5], 'a 403 means no rows for that computer; a computer that fails keeps the rows it had');

// an expired proposal the person dismissed stays hidden at the next read, and is hidden by its computer and team (not by its number alone)
dismissExpired(proposalItems().find(r => r.id === 4));
srv3Fails = false;
await refreshProposals(true);
assert.deepEqual(proposalItems().map(r => r.id), [5], 'the dismissed expired one stays hidden after a read');
console.log('proposals_state_hub: ok');
