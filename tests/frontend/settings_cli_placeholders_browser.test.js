// The CLI path fields say which program Coral looks for when they are empty (#10481, Beta Settings pass): "agy" alone did not say Antigravity, and Pi was not introduced. Isolated dev server, Settings > Agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`!!document.getElementById('settings-cli-path-agy')`, 'the CLI path fields', 15000);
        const got = await ev(`Object.fromEntries(['claude', 'codex', 'agy', 'pi'].map(t => [t, document.getElementById('settings-cli-path-' + t).placeholder]))`);
        assert.deepEqual(got, { claude: 'claude', codex: 'codex', agy: 'agy (Antigravity)', pi: 'pi (the Pi coding agent)' }, 'each field names its program: ' + JSON.stringify(got));
        console.log('PASS the CLI path placeholders name their program');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
