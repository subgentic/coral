// "Run your own hub" ends in something doable (#10572, Beta Home cards pass #10552): the last button reads Close (it said "Go to the dashboard", which this dialog is already on top of), and the hub's command is in a copy box
// with a Copy that puts it on the clipboard and says it did; the other machines are pointed to Remote access in Settings (never a bare --host 0.0.0.0 command: it does not turn remote access on and would be plain HTTP, Security Reviewer). 1280 px, isolated dev server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__copied = null; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); } catch (e) {} import((window.__coralStatic || '/static/') + 'editions.js').then(m => m.showHubSetup('own-hub')).then(() => true)`);
        await waitFor(`!!document.querySelector('#editions-modal .editions-steps')`, 'the Run your own hub screen', 8000);
        if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/own-hub-dialog.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        const s = await ev(`(() => { const m = document.getElementById('editions-modal'); const last = [...m.querySelectorAll('.editions-actions button')].pop(); return { last: last.textContent.trim(), boxes: [...m.querySelectorAll('.editions-commands')].map(b => b.textContent.replace(/\\\\s+/g, ' ').trim()), copy: [...m.querySelectorAll('button')].filter(b => /^Copy/.test(b.textContent.trim())).length, steps: [...m.querySelectorAll('.editions-steps li')].map(l => l.textContent.replace(/\\s+/g, ' ').trim()).join(' | ') }; })()`);
        if (s.last !== 'Close') problems.push(`the last button reads Close (it reads "${s.last}")`);
        if (s.boxes.length !== 1 || !/coral --hub/.test(s.boxes[0]) || /0\.0\.0\.0|--host/.test(s.boxes[0])) problems.push('one copy box holds the hub command and no bare 0.0.0.0 command: ' + JSON.stringify(s.boxes));
        if (!/Remote access/.test(s.steps) || !/Settings/.test(s.steps) || !/unencrypted/i.test(s.steps)) problems.push('the other machines are pointed to Remote access in Settings, which is unencrypted unless TLS is set up: ' + s.steps);
        if (s.copy !== 1) problems.push(`one Copy button (${s.copy})`);
        await ev(`[...document.querySelectorAll('#editions-modal button')].find(b => /^Copy/.test(b.textContent.trim()))?.click(); true`);
        await waitFor(`window.__copied !== null`, 'the copy', 3000).catch(() => problems.push('Copy puts the commands on the clipboard'));
        const copied = await ev(`window.__copied`);
        if (copied && !(/^coral --hub$/m.test(copied) && !/0\.0\.0\.0/.test(copied))) problems.push('what was copied is the hub command: ' + JSON.stringify(copied));
        const said = await ev(`[...document.querySelectorAll('#editions-modal button')].find(b => /^Cop/.test(b.textContent.trim()))?.textContent.trim()`);
        if (copied && said !== 'Copied') problems.push('Copy says Copied (it says ' + said + ')');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Run your own hub:\n  ' + problems.join('\n  '));
    console.log('PASS Run your own hub: Close, and both commands in one copy box');
})().catch(e => { console.error(e); process.exit(1); });
