// A proposal on a computer this hub cannot sign for has no Approve, Edit or Reject (#13454): reached by the hub's key alone the computer sees a script and refuses, so a button would only fail. A computer
// that holds the stamp secret (owner_stamp) keeps its buttons; this computer's own proposals are decided as ever. jsdom, no browser: node proposals_actions_hub.test.mjs
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const dom = new JSDOM('<!doctype html><body><script id="coral-boot" type="application/json">{"mode":"local"}</script></body>', { url: 'http://127.0.0.1:8420/' });
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'sessionStorage', 'getComputedStyle', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'AbortController', 'Element', 'HTMLDialogElement']) {
    Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.fetch = async () => new Response('', { status: 200, headers: { 'content-type': 'text/css' } });
const { state } = await import(pathToFileURL(path.join(dir, 'state.js')).href);
const { proposalActions } = await import(pathToFileURL(path.join(dir, 'inbox_proposals.js')).href);
state.hub = true;
state.servers = [{ id: 'signed', status: 'online', owner_stamp: true }, { id: 'older', status: 'online', owner_stamp: false }, { id: 'unknown', status: 'online' }];
const row = server => ({ id: 1, board_id: `@${server}/team`, kind: 'goal', title: 'Ship it', proposer: 'Dev', state: 'pending', server, rowKey: `proposal:@${server}/team:1` });
const labels = p => [...proposalActions(p).querySelectorAll('button')].map(b => b.textContent);

assert.deepEqual(labels(row('signed')), ['Approve', 'Edit', 'Reject'], 'a computer the hub can sign for keeps its buttons');
assert.deepEqual(labels(row('older')), [], 'a computer without the stamp secret: no buttons');
assert.deepEqual(labels(row('unknown')), [], 'a computer that has not said it can be signed for: no buttons');
assert.match(proposalActions(row('older')).textContent, /Decide it on that computer/);
assert.deepEqual(labels(row('local')), ['Approve', 'Edit', 'Reject'], "this computer's own proposals are decided as ever");
console.log('proposals_actions_hub: ok');
