// #11378: the panel for a computer added by URL. It asks first (a new line stops the old stamps), then shows the hub's setup line once, as text, with the command to run at that computer, and a Copy that
// falls back to a selected line. A refusal is shown as the hub worded it. Run: node server_owner_secret.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'local' });
const doc = dom.window.document;
const { mountOwnerSecret } = await importUi('server_owner_secret');

const SECRET = 'e'.repeat(64);
let calls = [];
function hub(answer) {
    calls = [];
    globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET' }); return answer(); };
}
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.fail('timed out: ' + what); }
const btn = (host, label) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const fresh = () => { const h = doc.createElement('div'); doc.body.append(h); return h; };

// asks first: nothing is sent until the person presses
{
    hub(() => json({ remote_id: 'web', setup_line: 'web ' + SECRET, command: 'coral hub-owner-secret', notice: 'x' }));
    const host = fresh();
    let closed = 0, changed = 0;
    mountOwnerSecret(host, { id: 'web', label: 'Workstation', onClose: () => closed++, onChanged: () => changed++ });
    assert.equal(calls.length, 0, 'a secret was asked for before the press');
    assert.match(host.textContent, /stops the old one until you paste the new line/);
    assert.ok(host.textContent.includes('Workstation'));
    assert.equal(host.querySelector('input'), null, 'a field before there is a line');

    btn(host, 'Make the line').click();
    await until(() => host.querySelector('#owner-secret-line'), 'the line');
    assert.deepEqual(calls, [{ url: '/api/servers/web/owner-secret', method: 'POST' }]);
    assert.equal(host.querySelector('#owner-secret-line').value, 'web ' + SECRET);
    assert.equal(host.querySelector('#owner-secret-line').readOnly, true);
    assert.ok(host.textContent.includes('coral hub-owner-secret'));
    assert.match(host.textContent, /not shown again/);
    assert.equal(changed, 1, 'the server list was told the hub now holds a secret');
    assert.equal(host.querySelector('.owner-secret img, .owner-secret script'), null);

    // Copy: the clipboard when it works, else the line selected
    let written = null;
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async t => { written = t; } }, configurable: true });
    btn(host, 'Copy').click();
    await until(() => written, 'the copy');
    assert.equal(written, 'web ' + SECRET);
    assert.match(host.querySelector('[role="status"]').textContent, /Copied/);
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('no'); } }, configurable: true });
    btn(host, 'Copy').click();
    await until(() => /Select the line/.test(host.querySelector('[role="status"]').textContent), 'the fallback');

    btn(host, 'Done').click();
    assert.equal(closed, 1);
    assert.equal(host.querySelector('#owner-secret-line'), null, 'the line stayed in the page after Done');
    assert.ok(!host.textContent.includes(SECRET), 'the secret is still in the page after Done');
}

// the hub's refusal is shown as the hub worded it, with no line
{
    hub(() => json({ error: 'only a person at the dashboard can set up Approve through this hub', code: 'operator_only' }, 403));
    const host = fresh();
    mountOwnerSecret(host, { id: 'web' });
    btn(host, 'Make the line').click();
    await until(() => host.querySelector('[role="alert"]'), 'the refusal');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'only a person at the dashboard can set up Approve through this hub');
    assert.equal(host.querySelector('#owner-secret-line'), null);
    assert.ok(btn(host, 'Make the line'), 'the person can try again');
}

// the hub cannot be reached
{
    hub(() => { throw new Error('network'); });
    const host = fresh();
    mountOwnerSecret(host, { id: 'web' });
    btn(host, 'Make the line').click();
    await until(() => host.querySelector('[role="alert"]'), 'the message');
    assert.match(host.querySelector('[role="alert"]').textContent, /Could not reach the hub/);
}

// unmounting clears the page and a late answer draws nothing
{
    let release;
    hub(() => new Promise(r => { release = () => r(json({ setup_line: 'web ' + SECRET })); }));
    const host = fresh();
    const m = mountOwnerSecret(host, { id: 'web' });
    btn(host, 'Make the line').click();
    await until(() => release, 'the request');
    m.unmount();
    release();
    await tick(40);
    assert.equal(host.textContent, '', 'a late answer was drawn after unmount');
}
console.log('server_owner_secret: ok');
