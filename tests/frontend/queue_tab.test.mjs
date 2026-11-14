// #16030 (the Operator's ask, 2026-11-13): the resource queue has its own tab with a computer picker. A linked computer's queue is read through the hub's link (GET /api/remote/<id>/api/resources), read-only, and
// one that stops answering keeps the last queue read with when it was last seen, never an empty queue. The Automations folder is the link to the tab. Stubbed fetch, jsdom.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
const AQ = await importUi('automations_queue');
const QT = await importUi('queue_tab');
const R = await importUi('routes');

const reads = []; let answers = {};
const holder = (id, agent, note) => ({ id, agent, note, task: 5, project: '', lease_until: new Date(Date.now() + 600e3).toISOString() });
const queueOf = (agent) => ({ resources: [{ name: 'mac-heavy', slots: 1, holders: [holder(1, agent, 'go test ./...')], queue: [{ id: 2, agent: agent + '-2', note: 'wait', place: 1, enqueued_at: new Date(Date.now() - 120e3).toISOString() }] }] });
globalThis.fetch = window.fetch = async url => {
    const u = String(url), m = /\/api\/remote\/([^/]+)\/api\/resources$/.exec(u), id = m ? m[1] : (u === '/api/resources' ? 'local' : null);
    if (!id) return new Response('{}', { status: 200 });
    reads.push(u);
    const a = answers[id];
    if (a === 'down') throw new TypeError('network');
    if (typeof a === 'number') return new Response('{}', { status: a });
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
};
const until = async f => { for (let i = 0; i < 300 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
const text = () => (document.getElementById('queue-tab-body') || {}).textContent || '';
const rows = () => [...document.querySelectorAll('#queue-tab-body tr[data-key]')];

// the route
assert.deepEqual(R.parse ? R.parse('/queue') : null, { view: 'queue' }, '/queue is a route');
assert.equal(R.parse('/queue/x'), null);
assert.equal(R.build({ view: 'queue' }), '/queue');
assert.ok(R.HIDDEN_IN_CLOUD.includes('queue'), 'the Hub does not serve the queue');

// one computer: no picker; this computer's own queue
state.hub = false; state.servers = [];
state.liveSessions = [{ session_id: 's-local', board_subscriber_id: 'local-agent' }, { session_id: 's-remote', board_subscriber_id: 'remote-agent' }]; // agents running on THIS computer: a linked computer's agents of the same name are not them
answers = { local: queueOf('local-agent') };
QT.showQueueTab();
await until(() => rows().length >= 2);
assert.equal(document.querySelector('#queue-tab-body select'), null, 'one computer: no picker');
assert.ok(text().includes('local-agent'));
assert.ok(document.querySelector('#queue-tab-body .queue-act'), "this computer's own queue has Move and Kick");
assert.ok(document.querySelector('#queue-tab-body .agent-link'), "this computer's agent opens its chat");

// linked computers: the picker lists each; a linked computer is read through the hub's link, read only
state.hub = true; state.servers = [{ id: 'box-2', label: 'Build box', status: 'online', last_seen: new Date().toISOString() }];
answers['box-2'] = queueOf('remote-agent');
QT.drawQueueTab();
const sel = document.querySelector('#queue-tab-body select');
assert.ok(sel, 'two computers: a picker');
assert.deepEqual([...sel.options].map(o => o.textContent), ['This computer', 'Build box']);
sel.value = 'box-2'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
await until(() => text().includes('remote-agent'));
assert.ok(reads.some(u => u === '/api/remote/box-2/api/resources'), 'the remote is read through the hub link: ' + reads);
assert.equal(document.querySelector('#queue-tab-body .queue-act'), null, 'a linked computer\'s queue has no Move or Kick');
assert.equal(document.querySelector('#queue-tab-body a, #queue-tab-body .agent-link'), null, 'its agents are not links into this computer, even when one of the same name runs here');
assert.match(text(), /read only/);
assert.ok(!text().includes('local-agent'), "this computer's rows are not shown under another computer's name");

// it stops answering: the last queue stays, with when it was last seen and read
state.servers = [{ id: 'box-2', label: 'Build box', status: 'offline', last_seen: new Date(Date.now() - 3 * 3600e3).toISOString() }];
answers['box-2'] = 'down';
await AQ.refreshQueue(); QT.drawQueueTab();
assert.ok(text().includes('remote-agent'), 'the last queue stays, not an empty one: ' + text());
assert.match(text(), /Build box: Not answering\.Last seen 3h ago/);
assert.match(text(), /The queue shown is the last one read/);

// a refusal and a malformed answer are said, not "nothing waiting"
answers['box-2'] = 403; state.servers[0].status = 'online';
await AQ.refreshQueue(); QT.drawQueueTab();
assert.match(text(), /Does not share its queue with the hub/);
assert.ok(text().includes('remote-agent'), 'a refusal keeps the last queue shown');
answers['box-2'] = { nothing: true };
await AQ.refreshQueue(); QT.drawQueueTab();
assert.match(text(), /not a queue/);
assert.ok(text().includes('remote-agent'));

// a computer never read: no rows, said plainly, never "no resource is defined"
state.servers.push({ id: 'new-1', label: 'Fresh', status: 'offline', last_seen: '' });
answers['new-1'] = 'down';
document.querySelector('#queue-tab-body select').value = 'new-1';
document.querySelector('#queue-tab-body select').dispatchEvent(new window.Event('change', { bubbles: true }));
await until(() => /Fresh/.test(text()) && /not answering|offline/i.test(text()));
assert.doesNotMatch(text(), /No resource is defined/, 'a computer that was never read is not an empty queue');

// a name is text, never markup
state.servers[1] = { id: 'new-1', label: '<img src=x onerror=alert(1)>', status: 'offline', last_seen: '' };
QT.drawQueueTab();
assert.equal(document.querySelector('#queue-tab-body img'), null);

// the Automations folder is the way to the tab
const moved = AQ.movedTable();
assert.deepEqual(moved.rows, []);
assert.match(moved.empty.line, /own tab/);
assert.equal(moved.empty.go.action, 'queue-tab-open'); // the browser suite presses it
console.log('PASS Queue tab: picker, linked computer read-only through the hub link, last queue kept, refusal said, Automations links to it');
process.exit(0);
