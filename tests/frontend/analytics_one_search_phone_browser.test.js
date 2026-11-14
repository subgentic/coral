// Analytics on a phone has one search box, not two (walk 47, #17032): the top bar's pill is the search of the views list, and the sidebar's own box above the views is not drawn beside it. The pill still filters the list. 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('tokens'); true`); await ev(framesJs(30));
        await ev(`document.querySelector('[data-on-click=analytics-phone-back]')?.click(); true`); await ev(framesJs(30));
        const boxes = () => ev(`[...document.querySelectorAll('input[type=search]')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map(e => e.placeholder)`);
        assert.deepEqual(await boxes(), ['Search Analytics'], 'one search box on the Analytics list: the top bar pill');
        const rows = () => ev(`[...document.querySelectorAll('#cost-nav-list .session-list-item')].filter(r => r.getClientRects().length).length`);
        const before = await rows();
        await ev(`(() => { const i = document.querySelector('.phone-bar-search'); i.value = 'zzzz-no-such-view'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await ev(framesJs(10));
        assert.ok(before === 0 || (await rows()) < before, 'typing in the pill still filters the views (' + before + ' before, ' + (await rows()) + ' after)');
        console.log('PASS Analytics has one search box on a phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
