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
            await ev(`(()=>{const old=window.fetch;window.fetch=(u,o={})=>{const p=new URL(String(u),location.href);if(p.pathname==='/api/team-artifacts')return Promise.resolve(Response.json({artifacts:[],total:0,has_more:false}));return old(u,o)};const row={name:'team-wait-agent',session_id:'team-wait-id',display_name:'Team waiting agent',agent_type:'claude',server:'local',board_project:${JSON.stringify(team)},sleeping:false,waiting_for_input:true,wait_ignored:true,waiting_kind:'permission',waiting_summary:'Permission still open',waiting_since:new Date().toISOString()};window.T.state.liveSessions=[row,{...row,server:'box-2',session_id:'other-computer-id',display_name:'Other computer agent'}];return true})()`);
            await ev(`window.openTeamPage(${JSON.stringify(team)})`);
            await waitFor(`document.querySelector('#team-tabs [role=tab]')?.getClientRects().length > 0`, 'team tabs visible');
            const tabs = await ev(`window.__tp.allTabs().map(tab => tab.querySelector('.team-tab-label').textContent.trim())`);
            try { assert.deepEqual(tabs.slice(0, 3), ['Goals', 'Needs you', 'Agents'], width + ': Needs you follows Goals'); }
            catch (error) { failures.push(error.message); continue; }
            await waitFor(`document.querySelector('#team-tab-needs .team-tab-count')?.textContent==='1'`,'unfiltered count before tab opens, excluding the same team on another computer');
            await ev(`window.__tp.allTabs().find(t => window.__tp.tabLabel(t) === 'Needs you').click(); true`);
            await waitFor(`location.pathname.endsWith('/needs') && document.querySelector('#team-panel-needs:not([hidden])')`, 'team Needs you route and panel');
            await waitFor(`document.querySelector('#team-panel-needs')?.textContent.includes('Team waiting agent')`,'shared list contains the local waiting agent');
            assert.equal(await ev(`document.querySelector('#team-panel-needs').textContent.includes('Other computer agent')`),false,'same team name on another computer is excluded');
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, width + ': no horizontal overflow');
        }
        assert.deepEqual(failures, [], 'Needs you is available at both widths');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
