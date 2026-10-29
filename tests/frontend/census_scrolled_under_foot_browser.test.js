// The 200% census does not call a row an overlap when it sits under a pinned foot of its own scroller and scrolling clears it (#11003, #10999: three long folder names made the sidebar list taller than its box, so at scroll 0 a
// header sat 7 px under the pinned "New agent" and the gate failed on the runner's fonts); and a real overlap, a control the scroll cannot clear, is still caught. A small page of its own, run through the census's own
// scaleOf. No dashboard needed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { scaleOf } = require('./helpers/phone_targets');

const PAGE = body => 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta name=viewport content="width=device-width"><body style="margin:0;font:16px sans-serif">' + body);
(async () => {
    const { client, Page, Emulation, ev } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        // a list in a scroller with a sticky foot: at scroll 0 the third row's bottom is under the foot, once scrolled it clears
        const rows = Array.from({ length: 12 }, (_, i) => `<li><button style="display:block;width:100%;height:40px">row ${i}</button></li>`).join('');
        const list = `<div id=sc style="height:300px;overflow-y:auto;position:relative"><ul style="list-style:none;margin:30px 0 0;padding:0">${rows}</ul><div style="position:sticky;bottom:0;background:#fff"><button style="height:44px;width:200px">New agent</button></div></div>`;
        await Page.navigate({ url: PAGE(list) }); await Page.loadEventFired();
        const a = await scaleOf(ev, 'under a pinned foot');
        assert.deepEqual(a.overlap, [], 'a row under the pinned foot that scrolling clears is not an overlap: ' + JSON.stringify(a.overlap));
        // a real overlap: two buttons drawn over each other with nothing to scroll
        await Page.navigate({ url: PAGE('<button style="position:absolute;left:20px;top:20px;width:120px;height:44px">First</button><button style="position:absolute;left:60px;top:30px;width:120px;height:44px">Second</button>') }); await Page.loadEventFired();
        const b = await scaleOf(ev, 'a real overlap');
        assert.ok(b.overlap.length >= 1, 'two controls drawn over each other are still caught: ' + JSON.stringify(b.overlap));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
