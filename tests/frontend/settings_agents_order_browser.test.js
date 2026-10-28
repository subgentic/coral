// Settings > Agents opens with Default models (#10526, Desktop Settings pass): the model a new agent uses is the first thing there, the other defaults (permission mode, working folder, thinking, CLI paths)
// come below it. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        await ev(`(async () => { await window.showSettingsModal('agents'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings');
        const top = (id) => ev(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().top`);
        const model = await top('settings-default-model-claude');
        for (const id of ['settings-permission-mode', 'settings-working-dir', 'settings-default-thinking-claude', 'settings-cli-path-claude']) {
            assert.ok(model < await top(id), `Default models come before ${id}`);
        }
        assert.ok(await top('settings-agents-models') < await top('settings-agents-defaults'), 'the Default models heading is above the Defaults heading');
        console.log('PASS Agents opens with Default models');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
