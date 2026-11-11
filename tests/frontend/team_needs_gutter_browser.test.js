// #15324 (walk 21 M3): at 960 px the team's Needs you table kept the page's 24 px gutter like the other tabs; it touched both screen edges.
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
        await Page.addScriptToEvaluateOnNewDocument({source:"localStorage.setItem('coral-inbox-needs-filters',JSON.stringify({agent:'Inbox person'}));"});
        for (const width of [960]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTeam(ev);
            await seed(ev, team);
            await ev(`(()=>{const old=window.fetch;window.__teamWrites=[];localStorage.setItem('coral-inbox-needs-filters',JSON.stringify({agent:'Inbox person'}));window.fetch=(u,o={})=>{const p=new URL(String(u),location.href);if(p.pathname==='/api/sessions/live')return Promise.resolve(Response.json(window.T.state.liveSessions));if(p.pathname.endsWith('/dismiss-wait')&&o.method==='POST'){const body=JSON.parse(o.body);window.__teamWrites.push({path:p.pathname,body});window.T.state.liveSessions.find(row=>row.session_id===body.session_id&&row.server==='local').wait_removed=true;return Promise.resolve(Response.json({removed:true}));}if(p.pathname==='/api/team-artifacts')return Promise.resolve(Response.json({artifacts:[],total:0,has_more:false}));return old(u,o)};const row={name:'team-wait-agent',session_id:'team-wait-id',display_name:'Team waiting agent',agent_type:'claude',server:'local',board_project:${JSON.stringify(team)},sleeping:false,waiting_for_input:true,wait_ignored:true,waiting_kind:'permission',waiting_summary:'Permission still open',waiting_since:new Date().toISOString()};window.T.state.liveSessions=[row,{...row,server:'box-2',session_id:'other-computer-id',display_name:'Other computer agent'}];return true})()`);
            await ev(`window.openTeamPage(${JSON.stringify(team)})`);
            await waitFor(`document.querySelector('#team-tabs [role=tab]')?.getClientRects().length > 0`, 'team tabs visible');
            await waitFor(`document.querySelector('#team-tab-needs .team-tab-count')?.textContent==='1'`,'unfiltered count before tab opens, excluding the same team on another computer');
            await ev(`window.__tp.allTabs().find(t => window.__tp.tabLabel(t) === 'Needs you').click(); true`);
            await waitFor(`document.querySelector('#team-panel-needs:not([hidden])')`, 'needs panel');
            await waitFor(`document.querySelector('#team-panel-needs')?.textContent.includes('Team waiting agent')`, 'row');
            const m = await ev(`(() => { const p = document.querySelector('#team-panel-needs'), t = p.querySelector('.dt-box, .dt-table, table'), b = t.getBoundingClientRect(), pr = p.getBoundingClientRect(); const page = p.querySelector('.goals-table-page'); const cs = page && getComputedStyle(page); return { vw: innerWidth, panelL: Math.round(pr.left), panelR: Math.round(pr.right), tblL: Math.round(b.left), tblR: Math.round(b.right), pagePad: cs && cs.paddingLeft + ' ' + cs.paddingRight, cls: t.className, pageCls: page && page.className }; })()`);
            assert.ok(m.tblL >= 16 && m.tblR <= m.vw - 16, 'the Needs you table keeps a gutter at 960 px (#15324, walk 21 M3): ' + JSON.stringify(m));
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
