// The Settings theme list is a live preview (#10481, Beta's Settings pass): choosing Light changes the page at once, before Save (the old dialog changed nothing until Save, so a person could not see the choice);
// Cancel or the close button puts the saved theme back and remembers nothing; Save keeps it. Isolated dev server; the settings are put back by the guard.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const theme = () => ev(`document.documentElement.getAttribute('data-theme')`);
    const pick = v => ev(`(() => { const s = document.getElementById('settings-theme'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the page applies the theme in a frame
    const openSettings = async () => { await ev(`window.showSettingsModal(); true`); await waitFor(`!!document.getElementById('settings-theme') && document.getElementById('settings-theme').options.length > 0`, 'the theme control', 15000); await settle(600); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.equal(await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'dark', custom_theme: '' }) }).then(r => r.status)`), 200);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await settle(500);
        assert.equal(await theme(), 'dark', 'the saved theme is Dark');
        await openSettings();
        await pick('light'); await settle(300);
        assert.equal(await theme(), 'light', 'choosing Light changes the page at once, before Save');
        const remembered = await ev(`localStorage.getItem('coral-theme')`);
        assert.notEqual(remembered, 'light', 'a preview is not remembered: ' + remembered);
        await ev(`window.hideSettingsModal(); true`); await settle(500);
        assert.equal(await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Discard changes' && b.getClientRects().length > 0)`), true, 'a changed theme is an unsaved change: closing asks before it discards (#10526)');
        await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard changes').click(); true`); await settle(500);
        assert.equal(await theme(), 'dark', 'closing without Save puts the saved Dark back');
        await openSettings(); await pick('light'); await settle(300);
        await ev(`window.applySettings(); true`);
        await waitFor(`document.getElementById('settings-modal').style.display === 'none'`, 'the dialog closes after Save', 10000); await settle(500);
        assert.equal(await theme(), 'light', 'Save keeps the previewed Light');
        console.log('PASS the Settings theme list previews at once');
    } finally { await guard.restore().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
