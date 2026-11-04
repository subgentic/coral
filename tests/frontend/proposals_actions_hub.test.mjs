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
const { proposalActions, openProposalDialog } = await import(pathToFileURL(path.join(dir, 'inbox_proposals.js')).href);
state.hub = true;
state.servers = [{ id: 'signed', status: 'online', owner_stamp: true }, { id: 'older', status: 'online', owner_stamp: false }, { id: 'unknown', status: 'online' }];
const row = server => ({ id: 1, board_id: `@${server}/team`, kind: 'goal', title: 'Ship it', proposer: 'Dev', state: 'pending', server, rowKey: `proposal:@${server}/team:1` });
const labels = p => [...proposalActions(p).querySelectorAll('button')].map(b => b.textContent);

assert.deepEqual(labels(row('signed')), ['Approve', 'Edit', 'Reject'], 'a computer the hub can sign for keeps its buttons');
assert.deepEqual(labels(row('older')), [], 'a computer without the stamp secret: no buttons');
assert.deepEqual(labels(row('unknown')), [], 'a computer that has not said it can be signed for: no buttons');
assert.match(proposalActions(row('older')).textContent, /Decide it on that computer/);
assert.deepEqual(labels(row('local')), ['Approve', 'Edit', 'Reject'], "this computer's own proposals are decided as ever");

// the decision dialog has its own gate (it opens from the row's title as well as from the buttons): Approve, Edit and Reject are hidden for a computer the hub cannot sign for, and it says where to decide
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
const shown = (server, mode) => {
    const d = openProposalDialog(row(server), mode);
    const visible = [...d.querySelectorAll('.proposal-buttons button')].filter(b => !b.hidden).map(b => b.textContent);
    const say = d.querySelector('.proposal-status').textContent;
    d.remove();
    return { visible, say };
};
for (const mode of ['view', 'edit', 'reject']) {
    assert.deepEqual(shown('older', mode).visible, ['Close'], `no decision button for a computer without the stamp secret (${mode})`);
    assert.match(shown('older', mode).say, /decide it on that computer/);
    assert.deepEqual(shown('unknown', mode).visible, ['Close']);
}
assert.ok(shown('signed', 'view').visible.includes('Approve') && shown('signed', 'view').visible.includes('Reject…'), 'a computer the hub can sign for keeps its decisions');
assert.ok(shown('local', 'view').visible.includes('Approve'), "this computer's own proposal keeps its decisions");
console.log('proposals_actions_hub: ok');
