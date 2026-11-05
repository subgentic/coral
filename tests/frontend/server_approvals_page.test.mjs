// #13230 (the Operator: Send to agent hidden on a computer set up over SSH, nothing to repair it): the page that sets up Approve through this hub for an SSH computer. It says what it does, asks for no terms,
// sends no data folder or backend, and runs from its own button. Run: node server_approvals_page.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'local' });
const doc = dom.window.document;
const { mountSshSetup } = await importUi('server_ssh_setup');

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

// ── the approvals plan: its words, no terms, the run ───────────────────────────────────────────────
{
    hub({ kind: 'approvals' });
    const host = fresh();
    let changed = 0;
    await toReady(host, 'manage', { server: { id: 'ssh-box', label: 'Build box' }, action: 'approvals', onChanged: () => { changed++; } });
    const text = host.textContent;
    assert.ok(/Set up Approve through this hub/.test(text), 'the title: ' + text);
    assert.ok(!/records who accepted/.test(text), 'no terms are asked for: it does not install Coral');
    assert.equal(host.querySelector('[data-ssh-go]').textContent.trim(), 'Set up approvals');
    assert.equal(host.querySelector('[data-ssh-go]').disabled, false);
    host.querySelector('[data-ssh-go]').click();
    await until(() => runBody, 'the run');
    assert.ok(!('accept_terms' in runBody) && !('backend' in runBody) && !('data_dir' in runBody) && !('port' in runBody), 'only a setup sends those: ' + JSON.stringify(runBody));
    await until(() => changed > 0, 'the server list is read again when it is done');
}
console.log('server_approvals_page: ok');
process.exit(0);
