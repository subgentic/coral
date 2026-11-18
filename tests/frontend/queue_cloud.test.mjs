// Hub 3.0, Queue in cloud (#19568, coral-hub fleet-views §7.1.1-7.1.2): in cloud mode /queue is a page (not sent home to Agents), the picker lists only the linked computers (no "This computer"), the first read is
// GET /api/remote/<first id>/api/resources, and no same-origin /api/resources is ever sent. Stubbed fetch, jsdom.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'cloud' });
const { state } = await importUi('state');
const QT = await importUi('queue_tab');
const R = await importUi('routes');

assert.ok(!R.HIDDEN_IN_CLOUD.includes('queue'), 'the Queue is shown in cloud');
assert.deepEqual(R.cloudRedirect(R.parse('/queue'), true), { view: 'queue' }, '/queue opens the Queue on the Hub, not Agents');
assert.doesNotMatch(fs.readFileSync(new URL('../../coral-go/pkg/frontend/templates/index.html', import.meta.url), 'utf8').split('\n').find(l => l.includes('id="nav-tab-queue"')), /data-local-only/, 'the Queue tab is not local-only');

const reads = [];
const q = agent => ({ resources: [{ name: 'mac-heavy', slots: 1, holders: [{ id: 1, agent, note: 'go test', task: 5, project: '', lease_until: new Date(Date.now() + 600e3).toISOString() }], queue: [] }] });
globalThis.fetch = window.fetch = async url => {
    const u = String(url);
    if (/\/api\/resources$/.test(u)) { reads.push(u); return new Response(JSON.stringify(q(u.includes('/box-1/') ? 'one-agent' : 'two-agent')), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return new Response('{}', { status: 200 });
};
const until = async f => { for (let i = 0; i < 300 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
const text = () => (document.getElementById('queue-tab-body') || {}).textContent || '';

state.hub = true;
state.servers = [{ id: 'box-1', label: 'Box one', status: 'online', last_seen: new Date().toISOString() }, { id: 'box-2', label: 'Box two', status: 'online', last_seen: new Date().toISOString() }];
QT.showQueueTab();
await until(() => text().includes('one-agent'));
const sel = document.querySelector('#queue-tab-body select');
assert.ok(sel, 'two computers: a picker');
assert.deepEqual([...sel.options].map(o => o.textContent), ['Box one', 'Box two'], 'cloud: only the linked computers, no This computer');
assert.equal(reads[0], '/api/remote/box-1/api/resources', 'the first read is the first linked computer, through the Hub');
assert.ok(reads.every(u => u.startsWith('/api/remote/')), 'no same-origin /api/resources: ' + JSON.stringify(reads));
sel.value = 'box-2'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
await until(() => text().includes('two-agent'));
assert.ok(reads.every(u => u.startsWith('/api/remote/')), 'still none after picking the second: ' + JSON.stringify(reads));
QT.leaveQueueTab();
console.log('PASS Queue in cloud: shown, the picker lists the linked computers only, reads go through /api/remote/<id>, no same-origin /api/resources');
