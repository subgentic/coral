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
        await Page.addScriptToEvaluateOnNewDocument({source:"localStorage.setItem('coral-inbox-needs-filters',JSON.stringify({agent:'Inbox person'}));"});
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTeam(ev);
            await seed(ev, team);
            await ev(`(()=>{const old=window.fetch;window.__teamWrites=[];localStorage.setItem('coral-inbox-needs-filters',JSON.stringify({agent:'Inbox person'}));window.fetch=(u,o={})=>{const p=new URL(String(u),location.href);if(p.pathname==='/api/sessions/live')return Promise.resolve(Response.json(window.T.state.liveSessions));if(p.pathname.endsWith('/dismiss-wait')&&o.method==='POST'){const body=JSON.parse(o.body);window.__teamWrites.push({path:p.pathname,body});window.T.state.liveSessions.find(row=>row.session_id===body.session_id&&row.server==='local').wait_removed=true;return Promise.resolve(Response.json({removed:true}));}if(p.pathname==='/api/team-artifacts')return Promise.resolve(Response.json({artifacts:[],total:0,has_more:false}));return old(u,o)};const row={name:'team-wait-agent',session_id:'team-wait-id',display_name:'Team waiting agent',agent_type:'claude',server:'local',board_project:${JSON.stringify(team)},sleeping:false,waiting_for_input:true,wait_ignored:true,waiting_kind:'permission',waiting_summary:'Permission still open',waiting_since:new Date().toISOString()};window.T.state.liveSessions=[row,{...row,server:'box-2',session_id:'other-computer-id',display_name:'Other computer agent'}];return true})()`);
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
            await ev(`(()=>{const button=[...document.querySelectorAll('#team-panel-needs button')].find(b=>/Filters/.test(b.getAttribute('aria-label')||b.textContent));button.click();return true})()`);
            await waitFor(`!!document.querySelector('#inbox-needs-team')?.getClientRects().length`,'team filter is visible');
            assert.match(await ev(`document.querySelector('#inbox-needs-team option[value=""]').textContent`),/^This team: /,'fixed scope is explicit instead of Any team');
            await ev(`(()=>{const done=[...document.querySelectorAll('#team-panel-needs button')].find(b=>b.textContent.trim()==='Done');const toggle=[...document.querySelectorAll('#team-panel-needs button')].find(b=>/Filters/.test(b.getAttribute('aria-label')||b.textContent));(done||toggle).click();return true})()`);

            await ev(`(()=>{const input=document.querySelector('#team-panel-needs input[type=search]');input.value='no matching agent';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
            await waitFor(`![...document.querySelectorAll('#team-panel-needs tbody tr[data-key]')].some(row=>row.textContent.includes('Team waiting agent'))`,'team search filters its rows');
            assert.equal(await ev(`document.querySelector('#team-tab-needs .team-tab-count').textContent`),'1','search does not narrow unfiltered tab badge');
            await ev(`window.__tp.allTabs().find(tab=>window.__tp.tabLabel(tab)==='Goals').click();true`);
            await waitFor(`location.pathname.endsWith('/goals')||location.pathname.endsWith('/'+${JSON.stringify(team)})`,'return to Goals');
            assert.equal(await ev(`JSON.parse(localStorage.getItem('coral-inbox-needs-filters')).agent`),'Inbox person','team filters never overwrite the Inbox profile');
            await ev(`window.__tp.allTabs().find(tab=>window.__tp.tabLabel(tab)==='Needs you').click();true`);
            await waitFor(`document.querySelector('#team-panel-needs input[type=search]')?.value==='no matching agent'`,'team filter survives leaving and returning');
            await ev(`(()=>{const input=document.querySelector('#team-panel-needs input[type=search]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
            await waitFor(`!!document.querySelector('#team-panel-needs tr[data-key="local:team-wait-id"]')`,'cleared search restores team row');
            if(width===390){
                await ev(`document.querySelector('#team-panel-needs .dt-mail-more-toggle').click();true`);
                await waitFor(`!![...document.querySelectorAll('#team-panel-needs [role=menuitem]')].find(item=>item.textContent.trim().startsWith('Remove from Needs you'))`,'shared phone Remove action');
                await ev(`[...document.querySelectorAll('#team-panel-needs [role=menuitem]')].find(item=>item.textContent.trim().startsWith('Remove from Needs you')).click();true`);
            }else{
                await waitFor(`!!document.querySelector('#team-panel-needs .inbox-remove-wait')`,'shared desktop Remove action');
                await ev(`document.querySelector('#team-panel-needs .inbox-remove-wait').click();true`);
            }
            await waitFor(`!document.querySelector('#team-panel-needs tr[data-key="local:team-wait-id"]')`,'shared removal updates team list');
            assert.deepEqual(await ev(`window.__teamWrites.map(write=>({path:write.path,remove:write.body.remove,session_id:write.body.session_id}))`),[{path:'/api/sessions/live/team-wait-agent/dismiss-wait',remove:true,session_id:'team-wait-id'}],'shared action posts only to the intended local agent');
            await waitFor(`document.querySelector('#team-tab-needs .team-tab-count')?.textContent===''`,'removal updates unfiltered team count');

        }
        assert.deepEqual(failures, [], 'Needs you is available at both widths');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
