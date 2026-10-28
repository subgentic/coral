// A new agent's first seconds are counted in the composer area on a phone too (#10504, the mobile tester: at 390 px the ~12 s while a first agent starts showed an empty chat, and the keyboard hides the chat's own
// "Starting Claude... N s"): a line above the message box says "Starting Claude... N s", counting, and is gone once the CLI is up. On the isolated dev
// server with the mock in ready mode and a start delay (MOCK_AGENT_START_DELAY). 390 px. Not on Windows (a script CLI).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('agent_start_progress_phone_browser: SKIPPED (a script CLI)'); process.exit(0); }

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
        const metrics = w => Emulation.setDeviceMetricsOverride({ width: w, height: w === 390 ? 844 : 800, deviceScaleFactor: 1, mobile: w === 390 }).then(() => Emulation.setTouchEmulationEnabled({ enabled: w === 390, maxTouchPoints: 5 }));
        await metrics(390);
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
        const count = () => ev(`(() => { const e = document.getElementById('composer-starting-count'), c = document.getElementById('command-input'); if (!e) return null; const r = e.getBoundingClientRect(), cr = c.getBoundingClientRect(); return { text: e.textContent.trim(), shown: e.getClientRects().length > 0, hidden: e.getAttribute('aria-hidden'), above: Math.round(cr.top - r.bottom), inColumn: r.left >= 0 && r.right <= innerWidth }; })()`);
        await waitFor(`!!document.getElementById('composer-starting-count') && /^Starting Claude\\.\\.\\. \\d+ s$/.test(document.getElementById('composer-starting-count').textContent.trim())`, 'the count above the message box', { timeout: 10000 }).catch(async e => { throw new Error(e.message + ' :: ' + JSON.stringify(await count())); });
        const c0 = await count(); const m0 = Number((c0.text.match(/(\d+) s$/) || [])[1]);
        assert.ok(c0.shown && c0.inColumn && c0.above >= 0 && c0.above < 160, 'the count sits just above the message box on the screen: ' + JSON.stringify(c0));
        assert.equal(c0.hidden, 'true', 'the seconds are not announced');
        if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR, 'start-count-phone.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        await new Promise(r => setTimeout(r, 2600)); // sleep-ok: the count moves once a second
        const m1 = Number(((await count()).text.match(/(\d+) s$/) || [])[1]);
        assert.ok(m1 >= m0 + 2, `the composer's seconds count up: ${m0} then ${m1}`);
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
        const done = await count();
        assert.ok(!done || !done.shown, 'once the CLI is up the count is gone: ' + JSON.stringify(done));
        console.log('PASS a phone counts the start above the message box, and it is gone when the CLI is up');
    } finally {
        try { await api('PUT', '/api/settings', { cli_path_claude: originalCli }); } catch { /* ok */ }
        try { if (launched) { const l = await ev(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).filter(s => s.working_directory === ${JSON.stringify(dir)}).map(s => ({ n: s.session_name || s.name, id: s.session_id }))`); for (const s of l) await api('POST', `/api/sessions/live/${encodeURIComponent(s.n)}/kill`, { agent_type: 'claude', session_id: s.id }); } } catch { /* ok */ }
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
