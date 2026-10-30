// A touch tablet's page follows the screen (#7326, the Operator's iPad bug): on an iPad in landscape Safari the dashboard ended above the bottom of the screen, an empty band under the sidebar and the composer.
// The page's height is --visual-viewport-height (mobile.js) with 100dvh as the fallback, and it was kept only for a phone's layout: a touch screen wider than that (an iPad) was left to 100dvh, which Safari answers
// stale after a rotation, the keyboard going away or a toolbar changing size. Here a touch screen of tablet size has the variable, it follows a rotation, a stale value is read again after pageshow, focusout and
// visibilitychange, and a desktop with a mouse still has none. Drives Chrome over CDP against the isolated dev server; WebKit itself is not available here.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const state = () => ev(`({ v: document.documentElement.style.getPropertyValue('--visual-viewport-height'), vv: Math.round(visualViewport.height * visualViewport.scale), inner: innerHeight, body: Math.round(document.body.getBoundingClientRect().height), coarse: matchMedia('(pointer: coarse)').matches, phone: matchMedia('(max-width: 767px)').matches })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const load = async (w, h, touch) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 2, mobile: touch }); await Emulation.setTouchEmulationEnabled({ enabled: touch });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        };
        console.log('1. an iPad in landscape (1366 x 1024, touch): the variable is set and the page is the screen tall');
        await load(1366, 1024, true);
        let s = await state();
        assert.equal(s.coarse, true); assert.equal(s.phone, false, 'a tablet is not the phone layout');
        assert.equal(s.v, `${s.vv}px`, `the variable follows the visual viewport: ${JSON.stringify(s)}`);
        assert.ok(Math.abs(s.body - s.inner) <= 1, `the page is the screen tall: ${JSON.stringify(s)}`);
        console.log('2. a rotation to portrait: the variable and the page follow');
        await Emulation.setDeviceMetricsOverride({ width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true });
        await waitFor(`document.documentElement.style.getPropertyValue('--visual-viewport-height') === Math.round(visualViewport.height * visualViewport.scale) + 'px' && innerHeight === 1366`, 'the variable to follow the rotation', 4000);
        s = await state(); assert.ok(Math.abs(s.body - s.inner) <= 1, `after the rotation the page is the screen tall: ${JSON.stringify(s)}`);
        console.log('3. a stale value is read again after pageshow, focusout and visibilitychange');
        for (const how of ['pageshow', 'focusout', 'visibilitychange']) {
            await ev(`document.documentElement.style.setProperty('--visual-viewport-height', '600px'); true`);
            await ev(`${how === 'visibilitychange' ? "document.dispatchEvent(new Event('visibilitychange'))" : `window.dispatchEvent(new Event('${how}'))`}; true`);
            await waitFor(`document.documentElement.style.getPropertyValue('--visual-viewport-height') !== '600px'`, `the stale 600px to be read again after ${how}`, 4000);
            s = await state(); assert.equal(s.v, `${s.vv}px`, `${how}: the variable is the visible height again`);
        }
        console.log('4. a desktop with a mouse keeps the CSS\'s own height: no variable');
        await load(1366, 1024, false);
        s = await state(); assert.equal(s.coarse, false); assert.equal(s.v, '', `a mouse and a window have no variable: ${JSON.stringify(s)}`);
        console.log('PASS a touch tablet\'s page follows the screen');
    } finally { await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
