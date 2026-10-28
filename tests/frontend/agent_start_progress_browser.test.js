// A new agent's first seconds are counted in its chat (#10299, Desktop pass 26): from Launch to a ready message box took 15 to 60 s with nothing that moved, so it looked stuck. On the isolated dev server with the mock
// in ready mode and a start delay (MOCK_AGENT_START_DELAY, the CLI that takes its time to come up): the new agent's empty chat says "Starting Claude... N s" with N counting up, then "Ready" once the CLI's first event
// arrives, then the ordinary "Say hello to your agent". 1280 px. Not on Windows (a script CLI).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('agent_start_progress_browser: SKIPPED (a script CLI)'); process.exit(0); }

(async () => {
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
    const words = () => ev(`(() => { const e = document.querySelector('#live-history-messages > .chat-empty'); return e ? { title: (e.querySelector('.chat-empty-title') || {}).textContent || '', hint: (e.querySelector('.chat-empty-hint') || {}).textContent || '', live: e.getAttribute('role') } : null; })()`);
    let originalCli = null, wrapperDir = '', dir = '', launched = null;
    try {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        const settings = await api('GET', '/api/settings');
        originalCli = settings.data && (settings.data.settings || settings.data).cli_path_claude;
        assert.ok(originalCli, 'the runner points cli_path_claude at the mock');
        wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-slowmock-'));
        const wrapper = path.join(wrapperDir, 'claude');
        fs.writeFileSync(wrapper, `#!/bin/sh\nMOCK_AGENT_READY=1 MOCK_AGENT_START_DELAY=9 exec "${originalCli}" "$@"\n`, { mode: 0o755 });
        assert.equal((await api('PUT', '/api/settings', { cli_path_claude: wrapper })).status, 200);
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coral-startprog-')));
        const res = await api('POST', '/api/sessions/launch', { working_dir: dir, agent_type: 'claude' });
        assert.ok(res.status < 300, 'launch: ' + JSON.stringify(res));
        launched = res.data;
        await waitFor(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(s => s.working_directory === ${JSON.stringify(dir)})`, 'the new agent in the live list', { timeout: 20000 });
        const row = await ev(`(window._coralGetLiveSessions() || []).find(s => s.working_directory === ${JSON.stringify(dir)})`);
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.selectLiveSession(${JSON.stringify(row.session_name || row.name)}, 'claude', ${JSON.stringify(row.session_id)}, ''); true`);
        await waitFor(`!!document.querySelector('#live-history-messages > .chat-empty')`, 'the empty chat', { timeout: 15000 });
        // counting: the title says Starting Claude... and a number that goes up
        await waitFor(`/^Starting Claude\\.\\.\\. \\d+ s$/.test(((document.querySelector('#live-history-messages > .chat-empty .chat-empty-title') || {}).textContent) || '')`, 'the counted start', { timeout: 15000 }).catch(async e => { throw new Error(e.message + ' :: ' + JSON.stringify(await words())); });
        const a = await words();
        const n0 = Number((a.title.match(/(\d+) s$/) || [])[1]);
        await new Promise(r => setTimeout(r, 2600)); // sleep-ok: the count moves once a second
        const b = await words();
        const n1 = Number((b.title.match(/(\d+) s$/) || [])[1]);
        assert.ok(n1 >= n0 + 2, `the seconds count up: ${a.title} then ${b.title}`);
        assert.match(b.hint, /first screen is not up yet|type below/i, 'the hint says it is coming up: ' + b.hint);
        assert.equal(await ev(`document.querySelector('#live-history-messages > .chat-empty .chat-empty-secs').getAttribute('aria-hidden')`), 'true', 'the seconds are not announced');
        // the CLI is up: Ready, then the ordinary words
        await waitFor(`((document.querySelector('#live-history-messages > .chat-empty .chat-empty-title') || {}).textContent || '') === 'Ready'`, 'Ready once the first event arrives', { timeout: 40000 }).catch(async e => { throw new Error(e.message + ' :: ' + JSON.stringify(await words())); });
        await waitFor(`((document.querySelector('#live-history-messages > .chat-empty .chat-empty-title') || {}).textContent || '') === 'Say hello to your agent'`, 'the ordinary words after Ready', { timeout: 10000 });
        console.log('PASS the new agent says Starting Claude... N s, counting, then Ready');
    } finally {
        try { await api('PUT', '/api/settings', { cli_path_claude: originalCli }); } catch { /* ok */ }
        try { if (launched) { const l = await ev(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).filter(s => s.working_directory === ${JSON.stringify(dir)}).map(s => ({ n: s.session_name || s.name, id: s.session_id }))`); for (const s of l) await api('POST', `/api/sessions/live/${encodeURIComponent(s.n)}/kill`, { agent_type: 'claude', session_id: s.id }); } } catch { /* ok */ }
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
