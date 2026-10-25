// The filter chips of the Goals and Tasks tabs are one line that scrolls sideways with its scrollbar hidden, 32 px high, the chosen chip kept in view (UI/UX #7453 round 1): at 390 px and at 200% text no chip is on a
// second line, the row scrolls (its scrollWidth is wider than the screen), and a chip chosen at the far end is in view. The two tabs' chips are the same height. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-chips-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const row = () => ev(`(() => { const r = [...document.querySelectorAll('#team-page-view .goals-chips-row')].find(e => e.getClientRects().length); if (!r) return null; const chips = [...r.children]; const rr = r.getBoundingClientRect(); return { tops: [...new Set(chips.map(c => Math.round(c.getBoundingClientRect().top)))], h: [...new Set(chips.map(c => Math.round(c.getBoundingClientRect().height)))], scroll: r.scrollWidth > r.clientWidth + 1, overflowX: getComputedStyle(r).overflowX, bar: getComputedStyle(r).scrollbarWidth, last: (() => { const l = chips[chips.length - 1].getBoundingClientRect(); return l.right <= rr.right + 1; })() }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await ev(`document.documentElement.style.fontSize = '200%'; true`);
        await seed(ev, TEAM); await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`); await openTeam(ev, waitFor, TEAM); await settle(500);
        let heights = [];
        for (const tab of ['Goals', 'Tasks']) {
            await S.run(`${tab} at 390 px and 200% text: one line, scrolls sideways, scrollbar hidden, 32 px`, async () => {
                await goTab(ev, settle, tab); await settle(300);
                const r = await row(); assert.ok(r, 'the chips row'); assert.equal(r.tops.length, 1, `all chips on one line (tops ${JSON.stringify(r.tops)})`); assert.equal(r.scroll, true, 'the row scrolls sideways');
                assert.equal(r.overflowX, 'auto'); assert.equal(r.bar, 'none', 'its scrollbar is hidden');
                assert.ok(r.h.every(x => Math.abs(x - 32 * 2) <= 4 || x >= 32), `chips are at least 32 px (${JSON.stringify(r.h)})`); heights.push(r.h.join());
            });
        }
        await S.run('the Goals and Tasks chips are the same height', async () => { assert.equal(heights[0], heights[1], `Goals ${heights[0]} and Tasks ${heights[1]}`); });
        await S.run('a chip chosen at the far end of the Tasks row is brought into view', async () => {
            await ev(`(() => { const r = [...document.querySelectorAll('#team-page-view .goals-chips-row')].find(e => e.getClientRects().length); r.lastElementChild.click(); return true; })()`); await settle(500);
            const inView = await ev(`(() => { const r = [...document.querySelectorAll('#team-page-view .goals-chips-row')].find(e => e.getClientRects().length); const p = r.querySelector('[aria-pressed=true]').getBoundingClientRect(), b = r.getBoundingClientRect(); return p.left >= b.left - 1 && p.right <= b.right + 1; })()`);
            assert.equal(inView, true, 'the chosen chip is inside the row');
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
