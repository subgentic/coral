// #14143: the team page exposes the Inbox's shared Needs you list, scoped to its team.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTeam, seed } = require('./helpers/team_page');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'team-needs-' + Date.now().toString(36);
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTeam(ev);
            await seed(ev, team);
            await ev(`window.openTeamPage(${JSON.stringify(team)})`);
            await waitFor(`document.querySelector('#team-tabs [role=tab]')?.getClientRects().length > 0`, 'team tabs visible');
            const tabs = await ev(`window.__tp.allTabs().map(window.__tp.tabLabel)`);
            try { assert.deepEqual(tabs.slice(0, 3), ['Goals', 'Needs you', 'Agents'], width + ': Needs you follows Goals'); }
            catch (error) { failures.push(error.message); continue; }
            await ev(`window.__tp.allTabs().find(t => window.__tp.tabLabel(t) === 'Needs you').click(); true`);
            await waitFor(`location.pathname.endsWith('/needs') && document.querySelector('#team-panel-needs:not([hidden])')`, 'team Needs you route and panel');
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, width + ': no horizontal overflow');
        }
        assert.deepEqual(failures, [], 'Needs you is available at both widths');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
