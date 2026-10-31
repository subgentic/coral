// The phone's ☰ drawer when its code cannot load (#11523 QA follow-up): the first tap loads phone_drawer.js; with the file unreachable (offline) the tap says "Menu didn't open"
// instead of doing nothing, and once the connection is back the next tap opens the drawer. Through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        const { Fetch } = client;
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        let offline = true;
        await Fetch.enable({ patterns: [{ urlPattern: '*phone_drawer.js*', requestStage: 'Request' }] });
        safePaused(client, p => (offline ? Fetch.failRequest({ requestId: p.requestId, errorReason: 'InternetDisconnected' }) : Fetch.continueRequest({ requestId: p.requestId })).catch(() => {}));
        const tap = () => ev(`document.querySelector('[data-on-click="m-top-menu"]:not([hidden])') ? (document.querySelector('[data-on-click="m-top-menu"]:not([hidden])').click(), true) : false`);
        await ev(`window.switchNavTab('automations'); true`);
        await waitFor(`!!document.querySelector('[data-on-click="m-top-menu"]') && [...document.querySelectorAll('[data-on-click="m-top-menu"]')].some(b => b.getClientRects().length)`, 'a visible ☰', 8000);
        await ev(`[...document.querySelectorAll('[data-on-click="m-top-menu"]')].find(b => b.getClientRects().length).click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Menu didn't open/.test(t.textContent))`, 'the message that the menu did not open', 6000);
        check(await ev(`document.getElementById('nav-more-menu').hidden`), 'the menu stays closed while the file is unreachable');
        offline = false;
        await ev(`[...document.querySelectorAll('[data-on-click="m-top-menu"]')].find(b => b.getClientRects().length).click(); true`);
        await waitFor(`!document.getElementById('nav-more-menu').hidden && document.getElementById('nav-more-menu').classList.contains('nav-drawer')`, 'the drawer opens on the next tap once the connection is back', 6000);
    } catch (e) { found.push(e.message); } finally { await client.close(); }
    assert.deepEqual(found, [], found.join('\n'));
    console.log('PASS phone_drawer_offline_browser');
})().catch(e => { console.error(e); process.exitCode = 1; });
