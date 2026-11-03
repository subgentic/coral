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
function hub({ keys = [], failConnect = false, keyChanged = false, kind = 'setup' } = {}) {
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
            if (keyChanged) return json({ plan: 'p1', kind: planKind, phase: 'failed', error: 'The host key has changed since you confirmed it. This may be a different computer.', key_changed: true, steps: steps({ connect: 'failed' }) });
            if (failConnect) return json({ plan: 'p1', kind: planKind, phase: 'failed', error: 'Could not connect.', steps: steps({ connect: 'failed' }) });
            return json({ plan: 'p1', target: 'user@box.example.com:22', server_id: 'ssh-box', label: 'Build box', kind: planKind, phase: keys.length ? 'needs_keys' : 'connected', host_keys: keys, system: 'Linux x86_64', steps: steps() });
        }
        if (url === '/api/servers/provision/p1/forget-key') return json({ plan: 'p1', target: 'user@box.example.com:22', server_id: 'ssh-box', label: 'Build box', kind: planKind, phase: 'planned', forgotten_keys: [{ host: 'box.example.com', type: 'ssh-ed25519', fingerprint: 'SHA256:oldoldold<img src=x onerror=alert(1)>' }], steps: steps() });
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
    assert.deepEqual(runBody, { accept_keys: true, backend: 'pty' }, 'only the key confirmation and the backend choice (pty by default) are sent: no key, and no terms (the hub makes the acceptance from its own)');
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
    assert.deepEqual(runBody, { backend: 'pty' }, 'no terms are sent: the hub makes the acceptance (only the backend choice)');
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
    assert.match(host.textContent, /If it fails after Coral was stopped, Coral on that computer stays stopped/); // a newer computer is the downgrade page's (server_upgrade_page.test.mjs)
    assert.match(host.textContent, /stays stopped/);
    assert.equal(host.querySelector('.ssh-terms'), null, 'an upgrade shows no terms either');
    assert.ok(host.querySelector('.ssh-consent'), 'but says what the computer records');
    btn(host, 'Upgrade').click();
    await until(() => runBody, 'the run');
    assert.deepEqual(runBody, {}, 'no terms are sent: the hub makes the acceptance');
}

// ── a changed host key offers Forget this host key, which asks the hub, then starts over and trusts nothing ─────
{
    hub({ keyChanged: true });
    const host = fresh();
    mountSshSetup(host, { mode: 'setup', pollMs: 5 });
    await until(() => $(host, '#ssh-host'), 'the form');
    $(host, '#ssh-host').value = 'user@box.example.com'; $(host, '#ssh-host').dispatchEvent(new dom.window.Event('input'));
    $(host, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => btn(host, 'Connect'), 'the plan');
    btn(host, 'Connect').click();
    await until(() => btn(host, 'Forget this host key'), 'the Forget button on a changed key');
    assert.match(host.textContent, /If you did not expect it, do not: it may be a different computer/, 'the warning is on the page');
    assert.equal(calls.some(c => c.path.endsWith('/forget-key')), false, 'nothing is forgotten until the person presses it');
    btn(host, 'Forget this host key').click();
    await until(() => btn(host, 'Connect'), 'the setup back at the start');
    const forget = calls.find(c => c.path.endsWith('/forget-key'));
    assert.equal(forget.method, 'POST');
    assert.equal(forget.body, null, 'nothing is sent with it: no host, no key');
    assert.match(host.textContent, /now forgotten: ssh-ed25519 SHA256:oldoldold/, 'the forgotten key is shown, to set beside the new one');
    assert.equal(host.querySelector('img'), null, 'a fingerprint from the hub became markup');
    assert.equal(btn(host, 'Set up'), undefined, 'nothing was trusted by forgetting');
    assert.equal(host.querySelector('[role="alert"]'), null);
    // a failure that is not a changed key has no such button
    hub({ failConnect: true });
    const other = fresh();
    mountSshSetup(other, { mode: 'setup', pollMs: 5 });
    await until(() => $(other, '#ssh-host'), 'the form');
    $(other, '#ssh-host').value = 'user@box.example.com'; $(other, '#ssh-host').dispatchEvent(new dom.window.Event('input'));
    $(other, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => btn(other, 'Connect'), 'the plan');
    btn(other, 'Connect').click();
    await until(() => other.querySelector('[role="alert"]'), 'the failure');
    assert.equal(btn(other, 'Forget this host key'), undefined, 'only a changed key offers it');
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
// ── a stop that was left while it ran is found again (#12372): the flow opens on the hub's plan, keeps watching it, and shows how it ended ──
{
    hub(); planKind = 'stop';
    const host = fresh();
    let changed = 0;
    mountSshSetup(host, { mode: 'manage', server: { id: 'ssh-box', label: 'Build box' }, action: 'stop', resume: 'p1', pollMs: 5, onChanged: () => changed++ });
    await until(() => host.querySelector('.ssh-steps'), 'the steps of the plan the hub has');
    assert.ok(calls.some(c => c.method === 'GET' && c.path === '/api/servers/provision/p1'), 'it read the plan from the hub');
    assert.ok(!calls.some(c => c.path === '/api/servers/provision/plan'), 'it made no new plan');
    assert.ok(!calls.some(c => c.path.endsWith('/run')), 'and started nothing');
    await until(() => changed === 1 && btn(host, 'Close'), 'the plan finished while it was shown');
    assert.ok(polls >= 2, 'it kept polling until the plan ended: ' + polls);
}
{ // a plan the hub no longer has (it expired or was dismissed) says so
    hub(); planKind = 'stop';
    globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('/options') ? options : { error: 'no such setup' }), { status: String(url).endsWith('/options') ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
    const host = fresh();
    mountSshSetup(host, { mode: 'manage', server: { id: 'ssh-box', label: 'Build box' }, action: 'stop', resume: 'gone', pollMs: 5 });
    await until(() => host.querySelector('[role="alert"]'), 'the sentence');
    assert.match(host.textContent, /no such setup|no longer on the hub/);
}
// QA's two shapes of the resume (#12372): a plan that already ended opens on its result and is not polled again, a failed one on its failure, and a running one goes on being polled until it ends
for (const [phase, word] of [['done', /Done/], ['failed', /did not|could not|Could not|failed/i]]) {
    hub(); planKind = 'stop'; let gets = 0;
    globalThis.fetch = async (url, init = {}) => {
        const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/servers/provision/options') return json(options);
        if (url === '/api/servers/provision/p1' && (init.method || 'GET') === 'GET') { gets++; return json({ plan: 'p1', kind: 'stop', phase, error: phase === 'failed' ? 'Could not stop Coral on that computer.' : '', steps: steps({ connect: 'ok', detect: phase === 'done' ? 'ok' : 'failed' }) }); }
        return json({}, 404);
    };
    const host = fresh();
    mountSshSetup(host, { mode: 'manage', server: { id: 'ssh-box', label: 'Build box' }, action: 'stop', resume: 'p1', pollMs: 5 });
    await until(() => btn(host, 'Close'), `the ${phase} plan opens on its result`);
    assert.match(host.textContent, word, `${phase}: the result is on the screen`);
    const seen = gets;
    await tick(60);
    assert.equal(gets, seen, `${phase}: an ended plan is read once and not polled again`);
    assert.equal(seen, 1);
}

// ── a failed restart shows the commands to run by hand under its step, as text in one block (#12947) ──────────────────────────────────
{
    hub(); planKind = 'upgrade';
    const help = ['# To see why, and to start it yourself, sign in to that computer and run these lines.', 'tail -n 40 ~/.coral-server/coral.log', 'kill "$(cat ~/.coral-server/coral.pid)"',
        'nohup ~/.coral-server/2.0.10/root/coral --host 127.0.0.1 --port 8420 <img src=x onerror=alert(1)> & echo $! > ~/.coral-server/coral.pid', '# Then choose Upgrade here again.'];
    globalThis.fetch = async (url, init = {}) => {
        const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/servers/provision/options') return json(options);
        if (url === '/api/servers/provision/p1' && (init.method || 'GET') === 'GET') {
            return json({ plan: 'p1', kind: 'upgrade', phase: 'failed', error: 'The new release could not be started on that computer: its start command ended with code 9.', steps: [
                { name: 'install', title: 'Install', state: 'ok', detail: 'Installed.' },
                { name: 'restart', title: 'Restart Coral', state: 'failed', detail: 'The new release could not be started on that computer: its start command ended with code 9.', help },
                { name: 'verify', title: 'Check the new release', state: 'pending' }] });
        }
        return json({}, 404);
    };
    const host = fresh();
    mountSshSetup(host, { mode: 'manage', server: { id: 'ssh-box', label: 'Build box' }, action: 'upgrade', resume: 'p1', pollMs: 5 });
    await until(() => host.querySelector('.ssh-step-help'), 'the commands under the failed step');
    const pre = host.querySelector('.ssh-step-help');
    assert.equal(pre.tagName, 'PRE', 'one block of preformatted text');
    assert.equal(pre.textContent, help.join('\n'), 'the lines, one to a line, exactly');
    assert.equal(host.querySelector('img'), null, 'a line from the hub became markup');
    assert.equal(host.querySelectorAll('.ssh-step-help').length, 1, 'only the failed step has them');
    assert.ok(pre.closest('.ssh-step').classList.contains('ssh-step-failed'), 'and it is under the failed step');
    assert.equal(pre.tabIndex, 0, 'a keyboard can reach it to scroll or select');
    assert.ok(pre.getAttribute('aria-label'), 'and it is named');
}

// ── the data folder on that computer is a setting the person can set (a Coral set up by hand keeps its data in .coral) ──
{
    const { cleanDataDir, dataDirOk } = await importUi('server_ssh_setup');
    assert.equal(cleanDataDir('  ~/.coral/ '), '.coral', 'a typed ~/ and a trailing slash are dropped');
    assert.equal(cleanDataDir('/x/y'), 'x/y');
    for (const ok of ['', '.coral', 'my-coral/data', '.coral-server/data']) assert.equal(dataDirOk(ok), true, ok);
    for (const bad of ['..', '../x', 'a/../b', 'a b', 'a;b', '-x', '$HOME', 'a//b', 'a/b/c/d/e/f']) assert.equal(dataDirOk(bad), false, bad);

    hub({ keys: [] });
    let host = fresh();
    mountSshSetup(host, { mode: 'setup', pollMs: 5 });
    await until(() => $(host, '#ssh-picked'), 'the form');
    $(host, '#ssh-picked').value = 'build-box'; $(host, '#ssh-picked').dispatchEvent(new dom.window.Event('change'));
    $(host, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => btn(host, 'Connect'), 'the plan');
    btn(host, 'Connect').click();
    await until(() => btn(host, 'Set up'), 'the connected step');
    const input = $(host, '#ssh-datadir-input');
    assert.ok(input, 'the data folder is a field of the set up');
    assert.equal(input.value, '', 'empty is the default');
    assert.match($(host, '#ssh-datadir-note').textContent, /~\/\.coral-server\/data/, 'and the note says what the default is');
    input.value = '../x'; input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(input.getAttribute('aria-invalid'), 'true', 'a folder that goes up is flagged');
    btn(host, 'Use .coral (a Coral set up by hand)').click();
    assert.equal($(host, '#ssh-datadir-input').value, '.coral');
    assert.match($(host, '#ssh-datadir-note').textContent, /~\/\.coral there/, 'the note says what will be used');
    btn(host, 'Set up').click();
    await until(() => runBody, 'the run');
    assert.deepEqual(runBody, { backend: 'pty', data_dir: '.coral' }, 'the chosen folder is sent');
}

console.log('server_ssh_setup: ok');
