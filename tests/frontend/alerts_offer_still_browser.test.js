// The alerts offer waits for a still pointer (#16841, walk 34 F12 and walk 26 M3): the strip pushes the page down by its height, so while the pointer is moving it stays away (a click aimed at a menu item
// landed on what moved), and it arrives once the pointer has been still for a second. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`(() => { function N() {} Object.defineProperty(N, 'permission', { get: () => 'default' }); N.requestPermission = async () => 'granted'; window.Notification = N; localStorage.clear(); return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('header.top-bar')`, 'the page');
        const top = () => ev(`Math.round(document.querySelector('main, .main-content, #main-content, body').getBoundingClientRect().top + (document.querySelector('.view-list-item, button')?.getBoundingClientRect().top || 0))`);
        const before = await top();
        await ev(`import(${MOD} + 'alerts_offer.js').then(m => m.offerAlertsAfterLaunch())`);
        for (let i = 0; i < 15; i++) { await ev(`document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))`); await new Promise(r => setTimeout(r, 200)); /* sleep-ok: the pointer keeps moving at a human's pace */ }
        assert.equal(await ev(`!!document.getElementById('alerts-offer-banner')`), false, 'no offer while the pointer is moving');
        assert.equal(await top(), before, 'nothing on the page moved while the pointer was moving');
        await waitFor(`!!document.getElementById('alerts-offer-banner')`, 'the offer comes once the pointer is still', { timeout: 6000 });
        console.log('alerts_offer_still_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
