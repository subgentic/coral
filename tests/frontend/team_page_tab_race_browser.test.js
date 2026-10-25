// A tab pressed before the previous tab's lazy module has loaded must not leave that tab's panel on screen (QA's #7535 review, board 11:2x): the page opens on Goals, whose module loads on the first visit; pressing
// Messages (or any tab) at once used to let Goals draw over it when its module arrived. After each load the page checks that its tab is still the chosen one. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-race-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            for (const tab of ['Messages', 'Agents']) {
                await S.run(`${label}: ${tab} pressed the moment the team opens leaves only ${tab} on screen`, async () => {
                    await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
                    await seed(ev, TEAM);
                    if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
                    await openTeam(ev, waitFor, TEAM).catch(() => {});
                    // press the tab in the same turn as the team opens: no wait for the Goals module
                    await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === ${JSON.stringify(tab)}); if (t) t.click(); return true; })()`);
                    await settle(2800); // sleep-ok: a late module load is what is being waited out
                    const shown = await ev(`[...document.querySelectorAll('#team-page-scroll > .team-panel')].filter(p => !p.hidden && p.getClientRects().length > 0).map(p => p.id)`);
                    assert.deepEqual(shown, [`team-panel-${tab.toLowerCase()}`], `only the ${tab} panel is shown (got ${JSON.stringify(shown)})`);
                });
            }
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
