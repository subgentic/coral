// The CLI path fields ask for a full path and say which program it is (#10481, #10735, Beta Settings pass): "agy" alone did not say Antigravity, and Pi was not introduced. Isolated dev server, Settings > Agents.
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
        const win = await ev(`/^win/i.test(navigator.userAgentData?.platform || navigator.platform || '')`); // the example is a Windows path on Windows (#10787): the platform the page reports decides which one is expected
        const eg = t => win ? `C:\\Program Files\\${t}\\${t}.exe` : `/usr/local/bin/${t}`;
        assert.deepEqual(got, { claude: `Full path, e.g. ${eg('claude')}`, codex: `Full path, e.g. ${eg('codex')}`, agy: `Full path, e.g. ${eg('agy')} (Antigravity)`, pi: `Full path, e.g. ${eg('pi')} (the Pi coding agent)` }, 'each field names its program: ' + JSON.stringify(got));
        console.log('PASS the CLI path placeholders name their program');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
