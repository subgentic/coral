// Settings on a phone by keyboard (#10644, the Settings keyboard and screen-reader pass): choosing a section from the list of sections (Enter on its row) opens the section and the list goes away, so the keyboard was on
// nothing (the next Tab started from the top); it lands on the section itself (the pane, named for the section) now, and Back puts it on the row it came from. 390 px with touch; the real dialog on the isolated dev
// server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a key's pane draws a moment after it
    const key = async (k, code, text) => { const b = { key: k, code: k, windowsVirtualKeyCode: code }; await client.Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(text ? { text } : {}) }); await client.Input.dispatchKeyEvent({ type: 'keyUp', ...b }); await sleep(80); }; // sleep-ok: a key's pane draws a moment after it
    const where = () => ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'the page (nothing)'; const pane = a.closest('.settings-pane'); return (pane ? 'in the ' + pane.dataset.title + ' section: ' : '') + a.tagName.toLowerCase() + (a.id ? '#' + a.id : ''); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`!!document.getElementById('settings-tab-network') && document.getElementById('settings-tab-network').getClientRects().length > 0`, 'the list of sections', 8000);
        await ev(`document.getElementById('settings-tab-network').focus(); true`);
        await key('Enter', 13, '\r');
        const at = await where();
        if (!/^in the Network and Hub section/.test(at)) problems.push(`Enter on a section's row puts the keyboard in that section (it is on ${at})`);
        await ev(`document.querySelector('#settings-modal .settings-back').focus(); true`); await key('Enter', 13, '\r');
        const back = await where();
        if (!/#settings-tab-network$/.test(back)) problems.push(`Back puts the keyboard on the row it came from (it is on ${back})`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Settings on a phone by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS Settings on a phone: the keyboard goes into a section and back to its row');
})().catch(e => { console.error(e); process.exit(1); });
