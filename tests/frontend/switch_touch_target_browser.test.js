// #15164 (walk 6 L18): a switch's track is 44 x 22, but a finger needs 44 px high: the area round the track (about 11 px above and below) hits the switch on a phone. 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        const probe = () => {
            const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:300px;left:100px;z-index:99999;background:#fff;padding:30px'; d.innerHTML = '<input type="checkbox" class="switch" id="sw-probe">'; document.body.append(d);
            const i = document.getElementById('sw-probe'), b = i.getBoundingClientRect(), x = b.left + b.width / 2, hit = dy => document.elementFromPoint(x, b.top + b.height / 2 + dy) === i;
            const out = { h: Math.round(b.height), above: hit(-20), below: hit(20), aboveFar: hit(-28), belowFar: hit(28) }; d.remove(); return out;
        };
        const r = await ev(`(${probe.toString()})()`);
        assert.ok(r.above && r.below, 'the area 20 px above and below the track hits the switch (a 44 px high target): ' + JSON.stringify(r));
        assert.ok(!r.aboveFar && !r.belowFar, 'and no further: ' + JSON.stringify(r));
    } finally { await client.close(); }
    console.log('switch_touch_target_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
