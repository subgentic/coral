// The 200% text census's detector (#6256, WCAG 1.4.4) finds what it is for: on a page with a fixed-height chip whose label is cut, two controls drawn over each other, a control past the screen's edge, a
// row wider than the screen and a 13px button that ignores the root font, at a root font of 32 px, helpers/phone_targets.js's SCALE and scaleOf report each; a clean page reports none of them. A census that finds nothing is only worth something if it can find something.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { SCALE, scaleOf } = require('./helpers/phone_targets');
(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        const before = await scaleOf(ev, 'dashboard');
        assert.deepEqual(before.fixed, [], 'every text on the dashboard grows with the root font: ' + JSON.stringify(before.fixed));
        await ev(`document.documentElement.style.fontSize = '32px'; true`);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page reflows at the new size
        const clean = await ev(SCALE);
        assert.deepEqual([clean.hscroll, clean.offscreen, clean.overlap, clean.clipped], [null, [], [], []], 'the dashboard itself has none of the four at 200%: ' + JSON.stringify(clean));
        await ev(`(() => {
            const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:100px;left:0;z-index:99999;background:#fff;color:#000;width:390px';
            d.innerHTML = '<button style="display:block;height:20px;width:60px;overflow:hidden;white-space:nowrap">Chip label that is long</button><div style="position:relative">'
                + '<button style="font-size:13px">Fixed size</button><button style="position:absolute;left:350px;top:60px;width:100px;height:40px">Gamma</button><button style="position:absolute;left:0;top:0;width:100px;height:40px">Alpha</button><button style="position:absolute;left:50px;top:0;width:100px;height:40px">Beta</button></div>';
            document.body.appendChild(d);
            const w = document.createElement('div'); w.style.cssText = 'width:600px;height:20px;background:red'; document.body.appendChild(w); return true; })()`);
        const r = await ev(SCALE);
        assert.ok(r.clipped.some(c => /Chip label/.test(c)), 'a cut label is found: ' + JSON.stringify(r));
        assert.ok(r.overlap.some(o => /Alpha/.test(o) && /Beta/.test(o)), 'two controls over each other are found: ' + JSON.stringify(r));
        assert.ok(r.offscreen.some(o => /Gamma/.test(o)), 'a control past the edge is found: ' + JSON.stringify(r));
        assert.ok(r.hscroll, 'a row wider than the screen is found: ' + JSON.stringify(r));
        // a scene whose text list is longer at the larger size (a control that appears when the text is big) is still measured: the label added there is found too, and the 13px one that was always there
        await ev(`(() => { const st = document.createElement('style'); st.textContent = '.late-at-200 { display: none } html[style*="32px"] .late-at-200 { display: block }'; document.head.appendChild(st); const b = document.createElement('button'); b.className = 'late-at-200'; b.style.fontSize = '13px'; b.textContent = 'Appears at 200'; document.body.appendChild(b); return true; })()`);
        await ev(`document.documentElement.style.fontSize = ''; true`);
        const after = await scaleOf(ev, 'made page');
        assert.ok(after.fixed.some(f => /Fixed size/.test(f)), 'text in px that ignores the root font is found: ' + JSON.stringify(after.fixed));
        // (a label that exists only at the larger size has no 16 px twin to compare with: it is not a pair, and not a pass by silence either: the 13px one beside it is still reported above)
        // a desktop on a computer with a touch screen (#352): touch emulation off, but navigator.maxTouchPoints above 0 and a screen narrower than the window (headless Chrome's is 800 px). The edge is
        // the window's: a control at 1100 px is on screen, one past 1280 is not
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, screenWidth: 800, screenHeight: 600, deviceScaleFactor: 1, mobile: false });
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`(() => { Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 10, configurable: true });
            for (const [t, l] of [['Inside', 1100], ['Outside', 1250]]) { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'position:fixed;top:300px;width:100px;height:40px;z-index:99999;left:' + l + 'px'; document.body.appendChild(b); }
            document.documentElement.style.fontSize = '32px'; return true; })()`);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page reflows at the new size
        assert.deepEqual(await ev(`[navigator.maxTouchPoints, screen.width, innerWidth]`), [10, 800, 1280], 'the touch-screen desktop is what is measured');
        const desk = await ev(SCALE);
        assert.ok(desk.offscreen.some(o => /Outside/.test(o)), 'a control past the window is found: ' + JSON.stringify(desk));
        assert.ok(!desk.offscreen.some(o => /Inside/.test(o)) && !desk.hscroll, 'nothing inside the window is cut off at the screen\'s 800 px: ' + JSON.stringify(desk));
        console.log('PASS the 200% detector finds a cut label, an overlap, a control past the edge, a wide row and text that did not grow, and nothing on the dashboard itself; on a touch-screen desktop the edge is the window\'s');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
