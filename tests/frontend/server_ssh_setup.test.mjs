// #11370: the set-up-over-SSH flow of the Servers tab. The hub does the work; the page walks the person through plan, connect and run, shows the host fingerprints and the terms as TEXT, sends back only
// "I accept" and the digest of the terms that were shown (never a key), and keeps Set up, Upgrade and Remove disabled until what must be confirmed is. Run: node server_ssh_setup.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'local' });
const doc = dom.window.document;
const { mountSshSetup } = await importUi('server_ssh_setup');

const options = { hosts: ['build-box', 'second'], acceptance_label: 'hub-owner@my-mac', records_acceptance: true };
const steps = (states = {}) => ['connect', 'detect', 'install', 'start', 'register'].map(n => ({ name: n, title: `Step ${n}`, state: states[n] || 'pending', detail: n === 'detect' && states.detect === 'ok' ? 'Linux x86_64, tmux found.' : '' }));

let calls, polls, planKind, runBody;
function hub({ keys = [], failConnect = false, kind = 'setup' } = {}) {
    calls = []; polls = 0; runBody = null;
    globalThis.fetch = async (url, init = {}) => {
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ method, path: String(url), body });
        const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/servers/provision/options') return json(options);
        if (url === '/api/servers/provision/plan') {
            planKind = body.action || 'setup';
            return json({ plan: 'p1', target: body.target || 'build-box (from your SSH config)', server_id: body.server_id || 'ssh-box', label: 'Build box', kind: planKind, phase: 'planned', steps: steps(), delete_data: !!body.delete_data }, 201);
        }
        if (url === '/api/servers/provision/p1/connect') {
            if (failConnect) return json({ plan: 'p1', kind: planKind, phase: 'failed', error: 'Could not connect.', steps: steps({ connect: 'failed' }) });
            return json({ plan: 'p1', target: 'user@box.example.com:22', server_id: 'ssh-box', label: 'Build box', kind: planKind, phase: keys.length ? 'needs_keys' : 'connected', host_keys: keys, system: 'Linux x86_64', steps: steps() });
        }
        if (url === '/api/servers/provision/p1/run') {
            runBody = body;
            return json({ plan: 'p1', kind: planKind, phase: 'running', steps: steps({ connect: 'ok' }) }, 202);
        }
        if (url === '/api/servers/provision/p1' && method === 'GET') {
            polls++;
            return polls < 2 ? json({ plan: 'p1', kind: planKind, phase: 'running', steps: steps({ connect: 'ok', detect: 'ok' }) })
                : json({ plan: 'p1', kind: planKind, phase: 'done', steps: steps({ connect: 'ok', detect: 'ok', install: 'ok', start: 'ok', register: 'ok' }) });
        }
        if (url === '/api/servers/provision/p1' && method === 'DELETE') return json({ status: 'cancelled' });
        return json({}, 404);
    };
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.fail('timed out: ' + what); }
const $ = (host, sel) => host.querySelector(sel);
const btn = (host, label) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label);

function fresh() { const host = doc.createElement('div'); doc.body.append(host); return host; }

// ── setup: plan, connect, keys, terms, run, progress ──────────────────────────────────────────────
{
    hub({ keys: [{ host: 'box.example.com', type: 'ssh-ed25519', fingerprint: 'SHA256:abc<img src=x onerror=alert(1)>' }] });
    const host = fresh();
    let closed = 0, changed = 0;
    mountSshSetup(host, { mode: 'setup', pollMs: 5, onClose: () => closed++, onChanged: () => changed++ });
    await until(() => $(host, '#ssh-host'), 'the target form');
    const opts = [...host.querySelectorAll('#ssh-picked option')].map(o => o.value);
    assert.deepEqual(opts, ['', 'build-box', 'second'], 'the SSH config hosts are the choices');

    $(host, '#ssh-host').value = 'user@box.example.com'; $(host, '#ssh-host').dispatchEvent(new dom.window.Event('input'));
    $(host, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => btn(host, 'Connect'), 'the plan');
    assert.deepEqual(calls.filter(c => c.path.includes('plan')).map(c => c.body), [{ target: 'user@box.example.com' }]);
    assert.ok(!calls.some(c => c.path.endsWith('/connect')), 'the plan screen connected before the press');
    assert.ok(host.textContent.includes('Nothing has connected yet'));
    assert.equal(host.querySelectorAll('.ssh-step').length, 5, 'the steps are listed');

    btn(host, 'Connect').click();
    await until(() => $(host, '#ssh-keys-ok'), 'the fingerprints');
    assert.equal(host.querySelector('.ssh-key-fp').textContent, 'SHA256:abc<img src=x onerror=alert(1)>');
    assert.equal(host.querySelector('img'), null, 'a fingerprint from the hub became markup');
    assert.equal(host.querySelector('.ssh-terms'), null, 'no terms are shown: the person accepted them when they opened Coral');
    assert.ok(!/By pressing|you accept/.test(host.textContent), 'the dialog asks for no acceptance');
    assert.equal(host.querySelector('.ssh-consent').textContent, 'That computer records who accepted (hub-owner@my-mac), when, and which version.', 'the one line is information');
    assert.ok(host.textContent.includes('hub-owner@my-mac'), 'the record names the hub computer');
    const go = btn(host, 'Set up');
    assert.equal(go.disabled, true, 'Set up is pressed only after the fingerprints are confirmed');
    $(host, '#ssh-keys-ok').checked = true; $(host, '#ssh-keys-ok').dispatchEvent(new dom.window.Event('change'));
    assert.equal(btn(host, 'Set up').disabled, false);

    btn(host, 'Set up').click();
    await until(() => runBody, 'the run');
    assert.deepEqual(runBody, { accept_keys: true }, 'only the key confirmation is sent: no key, and no terms (the hub makes the acceptance from its own)');
    await until(() => host.textContent.includes('Done. The computer is in your list.'), 'the progress to finish');
    assert.ok(changed >= 1, 'the server list was not told');
    btn(host, 'Close').click();
    assert.equal(closed, 1);
}

// ── a host whose key is already known: no fingerprint step ────────────────────────────────────────
{
    hub({ keys: [] });
    const host = fresh();
    mountSshSetup(host, { mode: 'setup', pollMs: 5 });
    await until(() => $(host, '#ssh-picked'), 'the form');
    $(host, '#ssh-picked').value = 'build-box'; $(host, '#ssh-picked').dispatchEvent(new dom.window.Event('change'));
    assert.equal($(host, '#ssh-host').disabled, true, 'a picked host and a typed one at once');
    $(host, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => btn(host, 'Connect'), 'the plan');
    assert.deepEqual(calls.find(c => c.path.endsWith('/plan')).body, { alias: 'build-box' });
    btn(host, 'Connect').click();
    await until(() => btn(host, 'Set up'), 'the terms');
    assert.equal($(host, '#ssh-keys-ok'), null);
    assert.equal(btn(host, 'Set up').disabled, false);
    btn(host, 'Set up').click();
    await until(() => runBody, 'the run');
    assert.deepEqual(runBody, {}, 'no terms are sent: the hub makes the acceptance');
}

// ── a failure says the hub's fixed sentence, and nothing is run ──────────────────────────────────
{
    hub({ failConnect: true });
    const host = fresh();
    mountSshSetup(host, { mode: 'setup', pollMs: 5 });
    await until(() => $(host, '#ssh-host'), 'the form');
    $(host, '#ssh-host').value = 'user@box.example.com'; $(host, '#ssh-host').dispatchEvent(new dom.window.Event('input'));
    $(host, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => btn(host, 'Connect'), 'the plan');
    btn(host, 'Connect').click();
    await until(() => host.querySelector('[role="alert"]'), 'the failure');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'Could not connect.');
    assert.equal(runBody, null);
    assert.equal(btn(host, 'Set up'), undefined, 'a failed connect offers Set up');
}

// ── an empty form says what to do and sends nothing ───────────────────────────────────────────────
{
    hub();
    const host = fresh();
    mountSshSetup(host, { mode: 'setup' });
    await until(() => $(host, '#ssh-host'), 'the form');
    $(host, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => host.querySelector('[role="alert"]'), 'the message');
    assert.match(host.querySelector('[role="alert"]').textContent, /Choose a host/);
    assert.ok(!calls.some(c => c.path.endsWith('/plan')));
}

// ── remove: the name must be typed; the plan says whether the data goes ───────────────────────────
{
    hub();
    const host = fresh();
    mountSshSetup(host, { mode: 'manage', server: { id: 'ssh-box', label: 'Build box' }, action: 'remove', deleteData: true, pollMs: 5 });
    await until(() => btn(host, 'Connect'), 'the plan');
    assert.deepEqual(calls.find(c => c.path.endsWith('/plan')).body, { server_id: 'ssh-box', action: 'remove', delete_data: true });
    assert.ok(host.textContent.includes('Deleted too'), 'the plan does not say the data goes');
    btn(host, 'Connect').click();
    await until(() => btn(host, 'Remove'), 'the confirm');
    assert.equal(btn(host, 'Remove').disabled, true, 'Remove before the name is typed');
    assert.equal(host.querySelector('.ssh-terms'), null, 'a remove shows no terms');
    $(host, '#ssh-typed').value = 'ssh-bo'; $(host, '#ssh-typed').dispatchEvent(new dom.window.Event('input'));
    assert.equal(btn(host, 'Remove').disabled, true);
    $(host, '#ssh-typed').value = 'ssh-box'; $(host, '#ssh-typed').dispatchEvent(new dom.window.Event('input'));
    assert.equal(btn(host, 'Remove').disabled, false);
    btn(host, 'Remove').click();
    await until(() => runBody, 'the run');
    assert.deepEqual(runBody, { confirm: 'ssh-box' }, 'a remove sends the typed name and no terms');
}

// ── upgrade: says it is a downgrade over a newer one, says what is recorded, and that a failure leaves it stopped ──
{
    hub();
    const host = fresh();
    mountSshSetup(host, { mode: 'manage', server: { id: 'ssh-box', label: 'Build box' }, action: 'upgrade', pollMs: 5 });
    await until(() => btn(host, 'Connect'), 'the plan');
    btn(host, 'Connect').click();
    await until(() => btn(host, 'Upgrade'), 'the confirm');
    assert.match(host.textContent, /even over a newer one/);
    assert.match(host.textContent, /downgrade/);
    assert.match(host.textContent, /stays stopped/);
    assert.equal(host.querySelector('.ssh-terms'), null, 'an upgrade shows no terms either');
    assert.ok(host.querySelector('.ssh-consent'), 'but says what the computer records');
    btn(host, 'Upgrade').click();
    await until(() => runBody, 'the run');
    assert.deepEqual(runBody, {}, 'no terms are sent: the hub makes the acceptance');
}

// ── cancel asks the hub to drop the plan ─────────────────────────────────────────────────────────
{
    hub();
    const host = fresh();
    let closed = 0;
    mountSshSetup(host, { mode: 'manage', server: { id: 'ssh-box', label: 'Build box' }, action: 'stop', onClose: () => closed++ });
    await until(() => btn(host, 'Cancel'), 'the plan');
    btn(host, 'Cancel').click();
    await until(() => closed === 1, 'close');
    assert.ok(calls.some(c => c.method === 'DELETE' && c.path === '/api/servers/provision/p1'), 'the plan was left on the hub');
}
console.log('server_ssh_setup: ok');
