// The 200% census's rule for a row under a pinned bar (#11003) must not let a REAL overlap through: a sticky HEADER that covers the first row of its scroller at scroll 0 cannot be cleared by scrolling (there is nothing above to scroll
// to; scrolling down only moves more rows under it), so it is still an overlap, while a row under a sticky FOOT that scrolling down clears is not (the author's case). Cases A (end of scroll), B (non-sticky pair in the scroller) and D
// (a fixed foot outside the scroller) already hold; C is this one. A small page through the census's own scaleOf.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { scaleOf } = require('./helpers/phone_targets');
const PAGE = body => 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta name=viewport content="width=device-width"><body style="margin:0;font:16px sans-serif">' + body);
(async () => {
    const { client, Page, Emulation, ev } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const rows = Array.from({ length: 12 }, (_, i) => `<li><button style="display:block;width:100%;height:40px">row ${i}</button></li>`).join('');
        await Page.navigate({ url: PAGE(`<div id=sc style="height:300px;overflow-y:auto;position:relative"><div style="position:sticky;top:0;margin-bottom:-14px;background:#fff;z-index:1"><button style="height:44px;width:200px">Header button</button></div><ul style="list-style:none;margin:0;padding:0">${rows}</ul></div>`) }); await Page.loadEventFired();
        const c = await scaleOf(ev, 'a sticky header over the first row at scroll 0');
        assert.ok(c.overlap.length >= 1, 'a sticky header over the first row at scroll 0 is an overlap scrolling cannot clear: ' + JSON.stringify(c.overlap));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
