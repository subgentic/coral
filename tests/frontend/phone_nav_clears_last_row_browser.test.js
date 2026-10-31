// The phone's floating bar must not cover the last row of a page (#11414 item 3, QA Engineer's release review): scrolled to its end, Docs' last topic is above the bar, not under it. 390 px with touch,
// the real Docs of the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // scroll every scrollable ancestor of `sel`'s last visible match to its end, then report how far its bottom is above the bar's top (negative: under the bar)
    const clearance = (sel) => ev(`(async () => {
        const items = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getClientRects().length); const last = items[items.length - 1]; if (!last) return { none: true };
        const scrollers = []; for (let p = last.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) scrollers.push(p); }
        const root = document.scrollingElement; scrollers.push(root);
        for (const s of scrollers) s.scrollTop = s.scrollHeight;
        await ${framesJs(3)};
        const nav = document.querySelector('.phone-nav'), n = nav && nav.getBoundingClientRect(), r = last.getBoundingClientRect();
        return { text: (last.textContent || '').trim().slice(0, 30), bottom: Math.round(r.bottom), navTop: n ? Math.round(n.top) : null, clear: n ? Math.round(n.top - r.bottom) : null };
    })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        // Docs: the last topic of the list
        await ev(`window.switchNavTab('docs'); localStorage.setItem('coral-sidebar-groups-docs', '[]'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the Docs topics', 12000);
        c = await clearance('#docs-nav-list li:last-child .row-btn, #docs-nav-list li:last-child');
        await shot('phone-nav-docs-before');
        assert.ok(!c.none && c.clear >= 8, `Docs: the last topic is above the bar, not under it (clear ${c.clear} px): ${JSON.stringify(c)}`);
        console.log('PASS the phone bar clears the last row of Docs');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
