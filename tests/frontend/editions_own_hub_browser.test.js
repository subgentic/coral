// "Run your own hub" (#10572, #15787): the last button reads Close, and no command is shown: people do not start Coral from a terminal, so the switch is the way. No coral --hub text, no copy box, no Copy button;
// the other machines are pointed to Remote access in Settings (never a bare --host 0.0.0.0 command, Security Reviewer); the switch row reads with a space between its title and its state. 1280 px, isolated dev
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__copied = null; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); } catch (e) {} import((window.__coralStatic || '/static/') + 'editions.js').then(m => m.showHubSetup('own-hub')).then(() => true)`);
        await waitFor(`!!document.querySelector('#editions-modal .editions-steps')`, 'the Run your own hub screen', 8000);
        if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/own-hub-dialog.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        await waitFor(`(() => { const st = document.querySelector('#editions-own-slot .own-hub-state'); return !!st && /^(On|Off)/.test(st.textContent.trim()); })()`, 'the switch row to read its state', 8000);
        const s = await ev(`(() => { const m = document.getElementById('editions-modal'); const last = [...m.querySelectorAll('.editions-actions button')].pop(); return { last: last.textContent.trim(), boxes: [...m.querySelectorAll('.editions-commands')].map(b => b.textContent.replace(/\\\\s+/g, ' ').trim()), copy: [...m.querySelectorAll('button')].filter(b => /^Copy/.test(b.textContent.trim())).length, all: m.textContent.replace(/\\s+/g, ' '), steps: [...m.querySelectorAll('.editions-steps li')].map(l => l.textContent.replace(/\\s+/g, ' ').trim()).join(' | ') }; })()`);
        if (s.last !== 'Close') problems.push(`the last button reads Close (it reads "${s.last}")`);
        if (s.boxes.length !== 0 || /coral --hub|0\.0\.0\.0|--host/.test(s.all)) problems.push('no command is shown anywhere in the dialog: ' + JSON.stringify(s.boxes) + ' ' + s.all);
        if (!/Remote access/.test(s.steps) || !/Settings/.test(s.steps) || !/unencrypted/i.test(s.steps)) problems.push('the other machines are pointed to Remote access in Settings, which is unencrypted unless TLS is set up: ' + s.steps);
        if (s.copy !== 0) problems.push(`no Copy button (${s.copy})`);
        if (/computerOff|computerOn|computerChecking/.test(s.all) || !/Run a hub on this computer\s+\S/.test(s.all)) problems.push('the switch title and its state are separated by a space: ' + s.all);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Run your own hub:\n  ' + problems.join('\n  '));
    console.log('PASS Run your own hub: Close, no command or Copy, a space in the switch row');
})().catch(e => { console.error(e); process.exit(1); });
