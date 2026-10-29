// Settings' Learn more beside Default permission mode is a link into Docs (#10765): following it closes the Settings dialog and lands on the answer in Docs, whose heading is in view and has the focus (#10906, the
// phone pass: the answer opened under the dialog, which stayed on top, and it looked as if nothing happened). 1280 and 390 px. Real isolated server; the settings guard puts the shard's settings back.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const guard = await require('./helpers/settings_guard').guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import(${MOD} + 'modals.js'); }).then(m => m.showSettingsModal('agents')).then(() => true)`);
            await waitFor(`!!document.getElementById('settings-permission-mode') && document.getElementById('settings-permission-mode').getClientRects().length > 0`, `${w}: the permission row`, 10000);
            assert.equal(await ev(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`), true, `${w}: Settings is open`);
            await ev(`document.getElementById('settings-permission-mode').closest('.sv-row').querySelector('a.sv-learn').click(); true`);
            await waitFor(`location.pathname === '/docs/how-do-i' && [...document.querySelectorAll('#docs-content h2')].some(h => h.textContent.trim() === 'What the permission modes allow')`, `${w}: the answer opens in Docs`, 12000);
            const at = await ev(`(() => { const modal = document.getElementById('settings-modal'), h = [...document.querySelectorAll('#docs-content h2')].find(e => e.textContent.trim() === 'What the permission modes allow'), r = h.getBoundingClientRect();
                const top = document.elementFromPoint(Math.min(innerWidth - 2, r.left + 10), Math.min(innerHeight - 2, Math.max(2, r.top + r.height / 2)));
                return { settingsShown: !!modal && getComputedStyle(modal).display !== 'none', inView: r.top >= 0 && r.bottom <= innerHeight, focused: document.activeElement === h, covered: !(top === h || h.contains(top)), settingsOnTop: !!top && !!top.closest('#settings-modal') }; })()`);
            assert.equal(at.settingsShown, false, `${w}: the Settings dialog is gone: ${JSON.stringify(at)}`);
            assert.equal(at.settingsOnTop, false, `${w}: nothing of Settings is over the answer: ${JSON.stringify(at)}`);
            assert.equal(at.inView, true, `${w}: the answer's heading is in view: ${JSON.stringify(at)}`);
            assert.equal(at.covered, false, `${w}: and nothing covers it: ${JSON.stringify(at)}`);
            assert.equal(at.focused, true, `${w}: and it has the focus: ${JSON.stringify(at)}`);
        }
        // with a change not saved yet Settings asks first: the link waits, Settings stays open, and nothing is lost behind the person's back
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import(${MOD} + 'modals.js'); }).then(m => m.showSettingsModal('agents')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-permission-mode') && document.getElementById('settings-permission-mode').getClientRects().length > 0`, 'unsaved: the permission row', 10000);
        await ev(`(() => { const s = document.getElementById('settings-permission-mode'); s.value = s.value === 'plan' ? 'default' : 'plan'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await ev(`document.getElementById('settings-permission-mode').closest('.sv-row').querySelector('a.sv-learn').click(); true`);
        await waitFor(`!!document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'unsaved: Settings asks before it closes', 6000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && location.pathname !== '/docs/how-do-i'`), true, 'unsaved: Settings stays open and Docs is not opened while the question is up');
        console.log('PASS Settings > Learn more closes Settings and lands on the answer in Docs, at 1280 and 390');
    } finally { await client.close(); await guard.restore?.(); }
})().catch(e => { console.error(e); process.exit(1); });
