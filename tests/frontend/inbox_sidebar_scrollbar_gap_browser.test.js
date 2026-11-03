// The Inbox sidebar's rows keep clear of the scrollbar and stay put when it appears (#12726, the Operator: "the folder counts and the selected row's highlight sit flush against the scrollbar"; the UI Reviewer: nothing may
// shift when the list starts to scroll, and 200% text too): in a window tall enough for the whole list and in one too short for it, at normal text and at 200%, the selected row's highlight and its count end at the
// same place, and (scrolling) at least 8 px before the scrollbar. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 1300, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('#inbox-nav-list .view-list-item[aria-current]')`, 'the selected folder row', 10000);
        const measure = () => ev(`(() => { const list = document.getElementById('inbox-nav-list'); const row = list.querySelector('.view-list-item[aria-current]'); let s = list.parentElement; while (s && !(['auto', 'scroll'].includes(getComputedStyle(s).overflowY))) s = s.parentElement;
            if (!s) return { error: 'no scroller' }; const sr = s.getBoundingClientRect(), r = row.getBoundingClientRect(), count = row.querySelector('.view-list-count'), cr = count && count.getBoundingClientRect(); const edge = sr.left + s.clientWidth;
            return { scrolls: s.scrollHeight > s.clientHeight + 1, rowRight: Math.round(r.right), countRight: cr ? Math.round(cr.right) : null, rowGap: Math.round(edge - r.right), countGap: cr ? Math.round(edge - cr.right) : null, scrollbar: Math.round(s.offsetWidth - s.clientWidth) }; })()`);
        for (const scale of ['100%', '200%']) {
            await ev(`document.documentElement.style.fontSize = ${JSON.stringify(scale)}; true`);
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 2600, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the layout settles after the text size and the window change
            const whole = await measure(); assert.ok(!whole.error, whole.error);
            assert.ok(!whole.scrolls, `${scale}: the tall window shows the whole list: ` + JSON.stringify(whole));
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 500, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: as above
            const part = await measure();
            assert.ok(part.scrolls, `${scale}: the short window makes the list scroll: ` + JSON.stringify(part));
            assert.ok(part.rowGap >= 8 && (part.countGap === null || part.countGap >= 8), `${scale}: the highlight and the count end 8 px or more before the scrollbar: ` + JSON.stringify(part));
            assert.ok(Math.abs(part.rowRight - whole.rowRight) <= 1 && Math.abs((part.countRight ?? 0) - (whole.countRight ?? 0)) <= 1, `${scale}: nothing shifts when the list starts to scroll (whole ${JSON.stringify(whole)}, scrolling ${JSON.stringify(part)})`);
        }
    } finally { await client.close(); }
    console.log('PASS the Inbox sidebar rows keep clear of the scrollbar and do not move when it appears');
})().catch(e => { console.error(e); process.exit(1); });
