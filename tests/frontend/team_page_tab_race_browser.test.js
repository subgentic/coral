// A tab pressed while the tab before it is still loading leaves only the tab pressed on screen (#7541, found by QA Reviewer 2 on #7535: Messages showed the Goals table above the chat). Every ordered pair of tabs is pressed in the
// same turn, so the first loader is still awaited when the second tab is chosen; the panels then show exactly one tab, the one pressed last. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, TABS, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-tabrace-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM);
        await openTeam(ev, waitFor, TEAM);
        const shown = () => ev(`[...document.querySelectorAll('[id^=team-panel-]')].filter(p => !p.hidden && p.id !== 'team-panel-item').map(p => p.id.replace('team-panel-', ''))`);
        for (const a of TABS) {
            await S.run(`pressing ${a} and then another tab at once leaves only the other tab's panel`, async () => {
                for (const b of TABS) {
                    if (a === b) continue;
                    await ev(`(() => { const by = n => window.__tp.allTabs().find(x => window.__tp.tabLabel(x) === n); by('Settings').click(); return true; })()`); await settle(150);
                    await ev(`(() => { const by = n => window.__tp.allTabs().find(x => window.__tp.tabLabel(x) === n); by(${JSON.stringify(a)}).click(); by(${JSON.stringify(b)}).click(); return true; })()`);
                    await settle(500);
                    assert.deepEqual(await shown(), [b === 'Board' ? 'messages' : b.toLowerCase()], `${a} then ${b}`); // the Board tab's panel keeps its old id, messages
                }
            });
        }
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
