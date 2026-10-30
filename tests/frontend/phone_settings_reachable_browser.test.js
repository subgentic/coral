// Settings on a phone (#11258 item 6, the phone NUX pass: 'Settings sits behind an unlabelled account icon'): the account button on the Agents header says what it opens, in its name and in a tooltip ('Settings and account'),
// and Settings is also reachable from the nav's More (the three dots): both open the one menu, and it lists Settings. 390 px, touch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.switchNavTab('agents'); true`);
        await waitFor(`!!document.querySelector('.phone-account-btn') && document.querySelector('.phone-account-btn').getClientRects().length > 0`, 'the account button', 15000);
        const a = await ev(`(() => { const b = document.querySelector('.phone-account-btn'), r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), title: b.getAttribute('title'), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
        assert.equal(a.name, 'Settings and account', 'the button is named for what it opens: ' + JSON.stringify(a));
        assert.equal(a.title, 'Settings and account', 'and has a tooltip: ' + JSON.stringify(a));
        assert.ok(a.w >= 44 && a.h >= 44, `a 44 px target: ${JSON.stringify(a)}`);
        const menuItems = () => ev(`[...document.querySelectorAll('#nav-more-menu [role=menuitem]')].filter(e => e.getClientRects().length).map(e => (e.lastElementChild || e).textContent.trim())`);
        const closeMenu = () => ev(`(() => { const m = document.getElementById('nav-more-menu'); if (m) m.hidden = true; return true; })()`);
        await ev(`document.querySelector('.phone-account-btn').click(); true`);
        await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the menu from the account button', 8000);
        assert.ok((await menuItems()).includes('Settings'), 'the account button opens a menu with Settings: ' + JSON.stringify(await menuItems()));
        await closeMenu();
        await ev(`document.querySelector('.phone-nav [data-phone-nav="nav-more"]').click(); true`);
        await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the menu from More', 8000);
        assert.ok((await menuItems()).includes('Settings'), 'the More button (the three dots) opens a menu with Settings: ' + JSON.stringify(await menuItems()));
        await ev(`[...document.querySelectorAll('#nav-more-menu [role=menuitem]')].find(e => (e.lastElementChild || e).textContent.trim() === 'Settings').click(); true`);
        await waitFor(`!!document.querySelector('#settings-modal, [id^=settings-modal]') && getComputedStyle(document.querySelector('#settings-modal')).display !== 'none'`, 'Settings opens from More', 10000);
        console.log('PASS Settings: the account button is named and has a tooltip; More lists Settings and opens it');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
