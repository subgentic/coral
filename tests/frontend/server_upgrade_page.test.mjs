// #12233: the Upgrade page and Set up's backend choice. The versions of the computer and of this hub side by side; "Up to date" when they match; a downgrade refused unless the person allows it (the checkbox gates the
// button and goes with the run); a warning before the upgrade when its agents will end; at Set up the two backends side by side with pty the default, tmux closed where it is not installed, and the choice sent
// with the run. Also the order of two versions. Run: node server_upgrade_page.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'local' });
const doc = dom.window.document;
const { mountSshSetup } = await importUi('server_ssh_setup');
const { compareVersions } = await importUi('server_status');

// the order of versions
assert.equal(compareVersions('2.0.33', '2.0.34'), -1);
assert.equal(compareVersions('2.1.0', '2.0.34'), 1);
assert.equal(compareVersions('2.0.34', '2.0.34'), 0);
assert.equal(compareVersions('2.0.34', '2.0.34-beta'), 1, 'a release is newer than its own pre-release');
assert.equal(compareVersions('v2.0.34', '2.0.34'), 0);
assert.equal(compareVersions('2.0.9', '2.0.10'), -1, 'numbers, not text');
assert.equal(compareVersions('', '2.0.34'), null, 'an unknown version is not older or newer');
assert.equal(compareVersions('not a version', '2.0.34'), null);

const options = { hosts: ['build-box'], acceptance_label: 'hub-owner@my-mac', records_acceptance: true };
const steps = () => ['connect', 'detect', 'install', 'start', 'register'].map(n => ({ name: n, title: `Step ${n}`, state: 'pending', detail: '' }));
let runBody;
function hub({ kind, remote = '2.0.33', hubV = '2.0.34', agentsSurvive, tmux } = {}) {
    runBody = null;
    const view = (phase, extra = {}) => ({ plan: 'p1', target: 'user@box.example.com:22', server_id: 'ssh-box', label: 'Build box', kind, phase, steps: steps(), ...(kind === 'upgrade' ? { hub_version: hubV, remote_version: remote, downgrade: remote !== '' && compareVersions(remote, hubV) === 1 } : {}), ...extra });
    globalThis.fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/servers/provision/options') return json(options);
        if (url === '/api/servers/provision/plan') return json(view('planned'), 201);
        if (url === '/api/servers/provision/p1/connect') return json(view('connected', { system: 'Linux x86_64', ...(agentsSurvive === undefined ? {} : { agents_survive: agentsSurvive }), ...(tmux === undefined ? {} : { tmux }) }));
        if (url === '/api/servers/provision/p1/run') { runBody = body; return json(view('running'), 202); }
        if (url === '/api/servers/provision/p1') return json(view('done'));
        return json({}, 404);
    };
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.fail('timed out: ' + what); }
const btn = (host, re) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent.trim()));
const fresh = () => { const h = doc.createElement('div'); doc.body.append(h); return h; };
async function toReady(host, mode, extra) {
    mountSshSetup(host, { mode, pollMs: 5, ...extra });
    if (mode === 'setup') {
        await until(() => host.querySelector('#ssh-picked'), 'the form');
        const sel = host.querySelector('#ssh-picked'); sel.value = 'build-box'; sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        host.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    }
    await until(() => btn(host, /^Connect$/), 'the plan');
    btn(host, /^Connect$/).click();
    await until(() => host.querySelector('[data-ssh-go]'), 'the ready page');
}

// ── upgrade: older computer ───────────────────────────────────────────────────────────────────────
{
    hub({ kind: 'upgrade', remote: '2.0.33', agentsSurvive: false });
    const host = fresh();
    await toReady(host, 'manage', { server: { id: 'ssh-box', label: 'Build box' }, action: 'upgrade' });
    const text = host.textContent;
    assert.ok(/This computer runs\s*Coral 2\.0\.33/.test(text) && /This hub runs\s*Coral 2\.0\.34/.test(text), 'both versions: ' + text);
    assert.equal(host.querySelector('[data-ssh-go]').textContent.trim(), 'Upgrade to v2.0.34');
    assert.equal(host.querySelector('[data-ssh-go]').disabled, false);
    assert.ok(/runs with the pty backend, not tmux/.test(host.querySelector('.ssh-agents-end')?.textContent || ''), 'a pty computer is warned before the upgrade, in words that are true whether or not tmux is installed there');
    assert.equal(host.querySelector('#ssh-allow-downgrade'), null);
    host.querySelector('[data-ssh-go]').click();
    await until(() => runBody, 'the run');
    assert.ok(!('allow_downgrade' in runBody), 'an upgrade asks for no downgrade');
}

// ── upgrade: the same version, and a computer that keeps its agents ──────────────────────────────
{
    hub({ kind: 'upgrade', remote: '2.0.34', agentsSurvive: false });
    const host = fresh();
    await toReady(host, 'manage', { server: { id: 'ssh-box', label: 'Build box' }, action: 'upgrade' });
    assert.ok(host.querySelector('.ssh-uptodate'), 'Up to date is said');
    assert.equal(host.querySelector('[data-ssh-go]').disabled, true, 'nothing to do');
    assert.equal(host.querySelector('.ssh-agents-end'), null, 'no warning when nothing restarts');
    hub({ kind: 'upgrade', remote: '2.0.30', agentsSurvive: true });
    const host2 = fresh();
    await toReady(host2, 'manage', { server: { id: 'ssh-box', label: 'Build box' }, action: 'upgrade' });
    assert.equal(host2.querySelector('.ssh-agents-end'), null, 'a tmux computer keeps its agents');
}

// ── upgrade: a downgrade is refused unless allowed ───────────────────────────────────────────────
{
    hub({ kind: 'upgrade', remote: '2.1.0' });
    const host = fresh();
    await toReady(host, 'manage', { server: { id: 'ssh-box', label: 'Build box' }, action: 'upgrade' });
    assert.ok(host.querySelector('.ssh-downgrade'), 'the newer version is said');
    const go = () => host.querySelector('[data-ssh-go]');
    assert.equal(go().textContent.trim(), 'Downgrade to v2.0.34');
    assert.equal(go().disabled, true, 'refused until allowed');
    host.querySelector('#ssh-allow-downgrade').click();
    await until(() => !go().disabled, 'the checkbox opens the button');
    go().click();
    await until(() => runBody, 'the run');
    assert.equal(runBody.allow_downgrade, true, 'the choice goes with the run');
}

// ── set up: the backends side by side ─────────────────────────────────────────────────────────────
{
    hub({ kind: 'setup', tmux: true });
    const host = fresh();
    await toReady(host, 'setup');
    const pty = host.querySelector('#ssh-backend-pty'), tmux = host.querySelector('#ssh-backend-tmux');
    assert.ok(pty && tmux, 'both choices');
    assert.equal(pty.checked, true, 'pty is the default');
    assert.equal(tmux.disabled, false);
    const text = host.querySelector('.ssh-backend').textContent;
    assert.ok(/agents end whenever Coral restarts/.test(text) && /Agents keep running when Coral restarts/.test(text), 'each says what it costs: ' + text);
    tmux.click(); tmux.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    host.querySelector('[data-ssh-go]').click();
    await until(() => runBody, 'the run');
    assert.equal(runBody.backend, 'tmux');
}
{
    hub({ kind: 'setup', tmux: false });
    const host = fresh();
    await toReady(host, 'setup');
    assert.equal(host.querySelector('#ssh-backend-tmux').disabled, true, 'tmux is closed where it is not installed');
    assert.ok(/tmux is not installed on that computer/.test(host.querySelector('.ssh-backend').textContent));
    host.querySelector('[data-ssh-go]').click();
    await until(() => runBody, 'the run');
    assert.equal(runBody.backend, 'pty');
}
{
    // tmux not known yet (the host key is still to be confirmed): the choice is open, with a note
    hub({ kind: 'setup' });
    const host = fresh();
    await toReady(host, 'setup');
    assert.equal(host.querySelector('#ssh-backend-tmux').disabled, false, 'tmux stays open while it is not known');
    assert.ok(/Checked when you press Set up/.test(host.querySelector('.ssh-backend').textContent));
}
console.log('server_upgrade_page: ok');
process.exit(0);
