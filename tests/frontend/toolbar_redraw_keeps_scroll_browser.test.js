// A list bar draws its pills on every draw (team_toolbar.js adopt), and the pressed pill was scrolled into view with block: 'nearest', which scrolls every ancestor: a list scrolled down was pulled back
// to its bar (#12354: on Linux a scrolled Needs you list jumped from 213 to 29 a quarter second after the person scrolled, whenever a late draw came). The pill may move sideways in its own row, nothing else
// scrolls. A bar above a long list in a scroller, the list scrolled down, the bar drawn again: the scroll position is the one it was.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 420, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const r = await ev(`(async () => {
            const m = await import((window.__coralStatic || '/static/') + 'team_toolbar.js');
            const sc = document.createElement('div'); sc.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:200px;overflow:auto;background:#fff;z-index:99999';
            const row = document.createElement('div'); row.className = 'list-bar-search-row';
            const tall = document.createElement('div'); tall.style.height = '1200px'; sc.append(row, tall); document.body.append(sc);
            const draw = () => m.adopt(row, { pills: { label: 'State', items: [{ key: 'all', label: 'All', count: 3 }, { key: 'open', label: 'Open', count: 2 }], current: 'open', onPick() {} } });
            draw(); sc.scrollTop = 500; const before = sc.scrollTop;
            draw(); await new Promise(r => setTimeout(r, 300)); // sleep-ok: a late scroll would show here, there is no event to wait for
            const out = { before, after: sc.scrollTop, pressed: !!row.querySelector('[aria-pressed="true"]') }; sc.remove(); return out; })()`);
        assert.equal(r.pressed, true, 'the bar drew its pills');
        assert.ok(r.before >= 400, 'the list was scrolled down: ' + JSON.stringify(r));
        assert.equal(r.after, r.before, 'drawing the bar again does not scroll the list: ' + JSON.stringify(r));
    } finally { await client.close(); }
    console.log('toolbar_redraw_keeps_scroll_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
