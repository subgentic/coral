// The team page's tab strip on a phone (#12538, the Mobile Beta Tester after Launch team, #12534): with the last tab (Board) the open one, the strip does not stop part-way through a tab (it started 'ents 3' for 'Agents 3'):
// the open tab is whole, and no tab is cut at the strip's left edge; opening the first tab again brings the strip back to its start. 390 and 430 px, a team seeded by the team page helpers. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-strip-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const strip = () => ev(`(() => { const s = document.getElementById('team-tabs'), sr = s.getBoundingClientRect(); const tabs = [...s.querySelectorAll('[role=tab]')].filter(t => t.getClientRects().length).map(t => { const r = t.getBoundingClientRect(); return { name: t.textContent.trim(), sel: t.getAttribute('aria-selected') === 'true', cutLeft: r.left < sr.left - 1 && r.right > sr.left + 1, whole: r.left >= sr.left - 1 && r.right <= sr.right + 1 }; });
        return { scrollLeft: Math.round(s.scrollLeft), cut: tabs.filter(t => t.cutLeft).map(t => t.name), sel: tabs.filter(t => t.sel).map(t => t.name + (t.whole ? '' : ' (not whole)')), n: tabs.length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[390, 844], [430, 932]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            const at = `${w}: `;
            await Page.navigate({ url: BASE + `/team/${TEAM}/messages` }); await Page.loadEventFired(); await install(); await coralReady(); // the page lands on Board, as after Launch team
            await waitFor(`(document.getElementById('team-page-title') || {}).textContent === ${JSON.stringify(TEAM)} && document.getElementById('team-tab-messages').getAttribute('aria-selected') === 'true'`, 'the team page on its Board tab', 15000); await settle(1500);
            const b = await strip();
            await shot(`team-tabs-board-${w}`);
            assert.ok(b.n >= 5, at + 'the strip has its tabs: ' + JSON.stringify(b));
            assert.deepEqual(b.cut, [], at + 'no tab is cut at the left edge with Board open: ' + JSON.stringify(b));
            assert.match(b.sel[0] || '', /^Board$/, at + 'the open tab is whole: ' + JSON.stringify(b));
            await ev(`document.getElementById('team-tab-goals').click(); true`); await settle(700);
            const g = await strip();
            assert.deepEqual([g.scrollLeft, g.cut, g.sel], [0, [], [g.sel[0]]], at + 'Goals again: the strip is at its start, nothing cut: ' + JSON.stringify(g));
            assert.ok(/^Goals/.test(g.sel[0]) && !/not whole/.test(g.sel[0]), at + 'Goals is whole: ' + JSON.stringify(g));
        }
    } finally { await removeBoards?.(ev, [TEAM]).catch?.(() => {}); await client.close(); }
    console.log('PASS the team tab strip rests on a tab edge on a phone');
})().catch(e => { console.error(e); process.exit(1); });
