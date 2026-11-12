// Settings > Learn more with a change not saved yet (#10906, QA's review): Settings asks first. Discard changes: Settings closes and the person lands on the answer in Docs, as they pressed the link to do (they cannot press it again:
// the dialog is gone). Keep editing: Settings stays, nothing is opened, and nothing is left waiting to scroll a Docs page the person opens by hand later. 1280 px, a real isolated server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const guard = await require('./helpers/settings_guard').guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`, ANSWER = 'What the permission modes allow';
    const problems = [];
    const open = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import(${MOD} + 'modals.js'); }).then(m => m.showSettingsModal('agents')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-permission-mode') && (document.querySelector('#settings-permission-mode.seg-source + .seg-list') || document.getElementById('settings-permission-mode')).getClientRects().length > 0`, 'the permission row', 10000);
        await ev(`(() => { const s = document.getElementById('settings-permission-mode'); s.value = s.value === 'plan' ? 'default' : 'plan'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await ev(`document.getElementById('settings-permission-mode').closest('.sv-row').querySelector('a.sv-learn').click(); true`);

    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await open();
        await waitFor(`location.pathname === '/docs/settings-system' && getComputedStyle(document.getElementById('settings-modal')).display === 'none'`,'Docs opens directly after autosave');
        assert.equal(await ev(`getComputedStyle(document.getElementById('confirm-modal')).display`),'none','no discarded-changes question');
        assert.equal(await ev(`!!document.getElementById('settings-save-btn')`),false);

    } finally { await client.close(); await guard.restore?.(); }
    assert.deepEqual(problems, [], 'Settings > Learn more with unsaved changes:\n  ' + problems.join('\n  '));
    console.log('PASS Settings Learn more opens Docs without a discarded-changes question');
})().catch(e => { console.error(e); process.exit(1); });
