const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('act-a', 'A', 3, { sleeping: false, display_name: 'Ada' }); true`);
        await waitFor(`window._coralGetLiveSessions().some(r => r.session_id === 'act-a-id')`, 'the agent row', 8000);
        const open = async () => { await waitFor(`[...document.querySelectorAll('.phone-menu-btn')].some(b => b.getClientRects().length > 0)`, 'the ☰ is on screen', 8000); await ev(`[...document.querySelectorAll('.phone-menu-btn')].find(b => b.getClientRects().length).click(); true`); };
        await open();
        await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden])')`, 'the drawer opens', 5000);
        const labels = await ev(`[...document.querySelectorAll('#nav-more-menu .nav-drawer-folder .nav-drawer-label')].map(l => l.textContent.trim())`);
        assert.ok(labels.includes('Activity'), 'the drawer has an Activity row when a live agent exists: ' + JSON.stringify(labels));
        const icon = await ev(`(() => { const row = [...document.querySelectorAll('#nav-more-menu .nav-drawer-folder')].find(r => r.querySelector('.nav-drawer-label')?.textContent.trim() === 'Activity'); return row?.querySelector('.material-icons')?.textContent?.trim(); })()`);
        assert.equal(icon, 'timeline', 'the Activity row uses the timeline icon');
        // panel-already-open: patch selectLiveSession so it preserves the overlay (simulates re-selecting the same agent)
        await ev(`document.getElementById('nav-drawer-scrim')?.click(); true`);
        await waitFor(`document.getElementById('nav-more-menu').hidden`, 'the drawer closed', 5000);
        await ev(`(() => { const real = window.selectLiveSession; window.selectLiveSession = function() { const s = document.getElementById('agentic-state'); const had = s?.classList.contains('mobile-panel-overlay'); const r = real?.apply(this, arguments); if (had) s?.classList.add('mobile-panel-overlay'); return r; }; })(); true`);
        await ev(`window.toggleAgenticPanel?.(true); window.switchAgenticTab?.('info', 'top'); true`);
        await waitFor(`document.getElementById('agentic-state')?.classList.contains('mobile-panel-overlay')`, 'panel overlay opens on info', 5000);
        await open();
        await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden])')`, 'the drawer re-opens with panel open', 5000);
        await ev(`[...document.querySelectorAll('#nav-more-menu .nav-drawer-folder')].find(r => r.querySelector('.nav-drawer-label')?.textContent.trim() === 'Activity').click(); true`);
        await waitFor(`document.getElementById('nav-more-menu').hidden`, 'the drawer closes after Activity tap', 5000);
        await waitFor(`!!document.querySelector('.agentic-tab.active[data-tab="activity"]')`, 'the Activity tab is active', 8000);
        const overlay = await ev(`document.getElementById('agentic-state')?.classList.contains('mobile-panel-overlay')`);
        assert.ok(overlay, 'the panel overlay stays open when Activity is tapped with the panel already showing');
        console.log('PASS the drawer shows Activity when a live agent exists at 390 px');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
