// #13378 (4): on the Hub's own page (boot mode 'cloud') the page has no computer of its own to count: review_counts.js asks only the computers the hub manages, never 'local'. (A separate process: the boot mode is read once.)
import assert from 'node:assert/strict';

globalThis.location = new URL('https://hub.test/');
globalThis.document = { getElementById: id => (id === 'coral-boot' ? { textContent: '{"mode":"cloud"}' } : null), querySelector: () => null };
globalThis.window = {};
const asked = [];
globalThis.fetch = async (url) => { const u = new URL(String(url), location.href); asked.push(u.pathname); return Response.json({ total: 4, artifacts: [] }); };
const { state } = await import('../../coral-go/pkg/frontend/static/state.js');
const C = await import('../../coral-go/pkg/frontend/static/review_counts.js');

// no computer online: nothing to ask, and the number stays unknown (the badge shows what it always did)
state.hub = true; state.servers = [];
assert.equal(await C.refreshCounts(), false); assert.equal(asked.length, 0, 'nothing asked'); assert.equal(C.countedUnread(), null);
// a computer online: asked through the proxy; this page's own address is never counted
state.servers = [{ id: 'box-2', status: 'online' }, { id: 'local', status: 'online' }];
assert.equal(await C.refreshCounts(true), true);
assert.deepEqual(asked, ['/api/remote/box-2/api/team-artifacts'], 'only the hub-managed computer, through its proxy: ' + asked.join(', '));
assert.equal(C.countedUnread(), 4);
console.log('review_counts_cloud: ok');
