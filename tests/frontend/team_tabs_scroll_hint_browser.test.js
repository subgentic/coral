// A phone's team tab strip says it scrolls (walk 81 item 9, #17816): the strip holds all eight tabs and a 390 px screen shows four, so while more tabs wait past the edge a 44 px "Show more tabs" button sits at
// its end (the 32 px fade alone did not read as "there is more"); tapping it brings the next tabs into view, and it is gone once the last tab is shown. A desktop strip, which fits, has none.
// Real seeded team over the API, real tap. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-hint-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const state = () => ev(`(() => { const t = document.getElementById('team-tabs'), b = document.getElementById('team-tabs-next'), shown = !!b && getComputedStyle(b).display !== 'none' && b.getClientRects().length > 0, r = b ? b.getBoundingClientRect() : null, tr = t.getBoundingClientRect();
        return { scrolls: t.scrollWidth > t.clientWidth + 1, left: Math.round(t.scrollLeft), max: t.scrollWidth - t.clientWidth, shown, name: b ? b.getAttribute('aria-label') : null, w: r && Math.round(r.width), h: r && Math.round(r.height), atEnd: !!r && Math.abs(r.left - tr.right) <= 1,
            last: (() => { const e = document.getElementById('team-tab-branches').getBoundingClientRect(); return e.right <= tr.right + 1; })() }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[390, true], [1440, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(800);
            let s = await state();
            if (!mobile) { assert.equal(s.scrolls, false, 'a desktop strip fits'); assert.equal(s.shown, false, 'and has no scroll button: ' + JSON.stringify(s)); continue; }
            assert.equal(s.scrolls, true, 'a phone strip scrolls: ' + JSON.stringify(s));
            assert.ok(s.shown && s.name === 'Show more tabs' && s.w >= 44 && s.h >= 44 && s.atEnd, 'a 44 px "Show more tabs" button sits beside the strip\'s end (right of it, over no tab: #18867) while tabs wait past the edge: ' + JSON.stringify(s));
            await ev(`document.getElementById('team-tabs-next').click(); true`);
            await waitFor(`document.getElementById('team-tabs').scrollLeft > 100`, 'the strip scrolled to the next tabs', 5000);
            for (let i = 0; i < 4 && (await state()).shown; i++) { await ev(`document.getElementById('team-tabs-next').click(); true`); await settle(500); }
            s = await state();
            assert.ok(s.last && !s.shown, 'at the last tab (Branches) the button is gone: ' + JSON.stringify(s));
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    console.log('PASS the phone team tab strip says it scrolls');
})().catch(e => { console.error(e.message); process.exit(1); });
