// A workflow's notice carries the agent's result, which the CLI prints as JSON; the popup says it in plain words and keeps the raw JSON behind Details (#10119, Desktop tester #10115).
// An error's reason is shown as the words; any other message is shown as it is. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const OK = '{"is_error":false,"result":"Mock agent goal","total_cost_usd":0,"type":"result","usage":{"input_tokens":43,"output_tokens":8}}';
const BAD = '{"type":"result","is_error":true,"result":"The folder does not exist: /tmp/x","usage":{"input_tokens":1}}';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const show = (title, message, level) => ev(`import((window.__coralStatic || '/static/') + 'notifications.js').then(m => { document.querySelectorAll('.alert-notification-overlay').forEach(o => o.remove()); m.showAlertNotification(${JSON.stringify(title)}, ${JSON.stringify(message)}, ${JSON.stringify(level)}); return true; })`);
        const read = () => ev(`(() => { const o = [...document.querySelectorAll('.alert-notification-overlay')].pop(); const d = o.querySelector('.alert-notification-details'); return { message: o.querySelector('.alert-notification-message')?.textContent, details: d ? d.querySelector('summary').textContent : null, open: d ? d.open : null, raw: d ? d.querySelector('pre').textContent : null, shown: d ? d.open : null }; })()`);
        await show('Daily Motivation', OK, 'success');
        let r = await read();
        assert.equal(r.message, 'Mock agent goal', 'the agent\'s words, not its JSON: ' + JSON.stringify(r));
        assert.equal(r.details, 'Details'); assert.equal(r.open, false, 'the raw JSON is closed behind Details'); assert.equal(r.shown, false);
        assert.deepEqual(JSON.parse(r.raw), JSON.parse(OK), 'and it is all there when opened');
        await waitFor(`(() => { const a = document.querySelector('.alert-notification'); return !!a && getComputedStyle(a).opacity === '1' && getComputedStyle(document.querySelector('.alert-notification-overlay')).opacity === '1'; })()`, 'the popup has finished appearing', 4000);
        if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/run-result-popup.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        await ev(`document.querySelector('.alert-notification-details summary').click(); true`);
        assert.equal((await read()).shown, true, 'Details opens to the raw result');
        await show('Daily Motivation', BAD, 'error');
        r = await read();
        assert.equal(r.message, 'The folder does not exist: /tmp/x', 'an error shows its reason: ' + JSON.stringify(r));
        await show('Build done', 'All 12 checks passed.', 'success');
        r = await read();
        assert.deepEqual([r.message, r.details], ['All 12 checks passed.', null], 'any other message is shown as it is, with no Details');
        await show('Odd', '{"note":"just some json"}', 'info');
        r = await read();
        assert.deepEqual([r.message, r.details], ['{"note":"just some json"}', null], 'JSON that is not a result stays as it is');
        console.log('\nPASS the result popup says the result in words, the JSON behind Details');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
