// Words the Mobile tester's pass 28 found at 390 px (#10376, one area per check): the phone's agent list is titled "Agents", not "Live Sessions" (a name from the code, not the page's: the sidebar says Agents).
// Isolated dev server, 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await waitFor(`!!document.querySelector('.mobile-list-title') && document.querySelector('.mobile-list-title').getClientRects().length > 0`, 'the phone list title', 15000);
        assert.equal(await ev(`document.querySelector('.mobile-list-title').textContent.trim()`), 'Agents', 'the phone list is titled Agents');
        console.log('PASS the phone words at 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
