// A real server stop (#10536, Desktop recheck, Mobile Beta Tester): the page says "No connection, retrying" when the server it talks to is gone, and after the server comes back the page works without a reload
// (the Inbox is not "Page not found"). The server is a private Coral of this suite's own (an empty data folder and HOME, strict local auth off), really stopped with SIGTERM and started again on the same
// port: not the page's WebSocket stood in. Expects CDP_PORT and CORAL_TEST_BIN (the built coral, from run_cdp_suites.mjs). 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('./helpers/child_process.js');
const CDP = require('chrome-remote-interface');

if (process.platform === 'win32') { console.log('server_stop_real_browser: skipped on Windows'); process.exit(0); }
const BIN = process.env.CORAL_TEST_BIN;
if (!BIN || !fs.existsSync(BIN)) { console.error('CORAL_TEST_BIN is not set to a built coral (run this through run_cdp_suites.mjs)'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: server start-up poll spacing
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

(async () => {
    const root = fs.mkdtempSync(path.join(require('./helpers/tmp_root'), 'coral-stop-')), home = path.join(root, 'home'), data = path.join(root, 'data'), bin = path.join(root, 'bin');
    for (const d of [home, data, bin]) fs.mkdirSync(d);
    const port = await freePort(); assert.notEqual(port, 8420);
    const base = `http://127.0.0.1:${port}`;
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: root, CORAL_DATA_DIR: data, CORAL_TELEMETRY_DISABLED: '1', CORAL_NO_DEMO_SEED: '1', CORAL_NO_WELCOME: '1' };
    let proc = null, exited = true;
    const start = async () => {
        exited = false;
        proc = spawn(BIN, ['--home', data, '--host', '127.0.0.1', '--port', String(port), '--no-browser', '--cloud-url', 'off', '--backend', 'pty', '--strict-local-auth=false'],
            { env, stdio: ['ignore', fs.openSync(path.join(root, 'coral.log'), 'a'), fs.openSync(path.join(root, 'coral.log'), 'a')], detached: true });
        proc.on('exit', () => { exited = true; });
        for (let i = 0; i < 300; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ } await sleep(100); }
        throw new Error('the private server did not start:\n' + fs.readFileSync(path.join(root, 'coral.log'), 'utf8').slice(-600));
    };
    const stop = async () => {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* gone */ }
        for (let i = 0; i < 100 && !exited; i++) await sleep(100);
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
    };
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await start();
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: base + '/' }); await Page.loadEventFired(); await coralReady();
        const STATE = `import((window.__coralStatic || '/static/') + 'state.js').then(m => m.state)`;
        await waitFor(`${STATE}.then(s => !!s.coralWs && s.coralWs.readyState === 1)`, 'the live feed is open', { timeout: 10000 });
        await sleep(10000); // sleep-ok: the page settles after its first reads (the bar's module is fetched eight seconds in); the server is stopped on a settled page
        await stop();
        // 1. the server is really gone: the page says so after a few seconds
        await waitFor(`(document.getElementById('connection-bar') || {}).textContent === 'No connection, retrying'`, 'the No connection bar after the real stop', { timeout: 20000 });
        console.log('   ok 1: the bar says No connection, retrying');
        // the person opens the Inbox while the server is down: its files cannot be fetched
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await sleep(2000); // sleep-ok: the tab tries to draw against the dead server
        // 2. the server is back: the bar goes, and the Inbox works with no reload
        await start();
        await waitFor(`!document.getElementById('connection-bar') || document.getElementById('connection-bar').textContent === 'Back online'`, 'the bar says Back online or is gone', { timeout: 45000 });
        await waitFor(`!document.getElementById('connection-bar')`, 'the bar is gone', { timeout: 15000 });
        await waitFor(`!/Page not found/.test(document.body.innerText) && /Needs you|Inbox/.test(document.body.innerText)`, 'the Inbox, not "Page not found", after the restart with no reload', { timeout: 20000 });
        console.log('PASS A real server stop: the bar says so, and the page works again after the restart');
    } finally {
        await client.close().catch(() => {});
        await stop().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
