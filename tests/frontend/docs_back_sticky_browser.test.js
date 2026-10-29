// The Docs page's way back stays on screen down a long answer on a phone (#10908, the second phone pass: the "← Docs" link scrolled away). 390 px; the isolated dev server's own docs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.switchNavTab('docs'); true`); await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc], #mobile-docs-list [data-doc]').length >= 3`, 'the topics', 15000);
        await ev(`window.selectDoc((document.querySelector('#docs-nav-list [data-doc]') || document.querySelector('#mobile-docs-list [data-doc]')).dataset.doc); true`);
        await waitFor(`!!document.querySelector('#docs-content .phone-title-row') && document.querySelectorAll('#docs-content h2').length >= 1`, 'the topic', 15000);
        const r = await ev(`(async () => { const b = document.querySelector('#docs-content .phone-title-row'); let sc = b.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
            if (!sc) return { noScroller: true }; const before = b.getBoundingClientRect().top; sc.scrollTop = Math.min(sc.scrollHeight, 1500); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: the sticky row settles */
            const after = b.getBoundingClientRect(), s = sc.getBoundingClientRect(); return { before: Math.round(before), scrolled: sc.scrollTop, afterTop: Math.round(after.top), scTop: Math.round(s.top), h: Math.round(after.height) }; })()`);
        assert.ok(!r.noScroller && r.scrolled > 200, 'the doc scrolls: ' + JSON.stringify(r));
        assert.ok(r.afterTop >= r.scTop - 1 && r.afterTop <= r.scTop + 4, 'the way back is still at the top after scrolling: ' + JSON.stringify(r));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
