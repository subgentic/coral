// #17307: tablet/desktop team walk. Real wizard, team header and removal; task names remain compact but can be read with a tap.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const NT = require('./helpers/new_team');
const TP = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, problems = [], boards = [];
    const check = (ok, why) => { if (!ok) problems.push(why); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [768, 1280]) {
            const team = 'walk61-' + width + '-' + Date.now().toString(36); boards.push(team);
            await Emulation.setDeviceMetricsOverride({ width, height: 1024, deviceScaleFactor: 1, mobile: false });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 768 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await NT.install(ev); await NT.stubModels(ev); await TP.install(ev);
            await NT.openNewTeam(ev, waitFor); const t = NT.T(ev, waitFor); await t.to(2);
            await waitFor(`document.querySelector('#team-agents-list .acf-model-select option')`, 'models loaded');
            const summary = await ev(`(async () => { const d = await import(${S}+'team_dialogs.js'), a = await import(${S}+'agent_config_form.js'); const row = document.querySelector('#team-agents-list .team-agent-row'); window.T.state.settings.default_model_claude='claude-haiku-5-5'; a.setAgentConfig(row.dataset.acfId,{...a.getAgentConfig(row.dataset.acfId),model:''}); d._syncTeamMembers(); return row.querySelector('.team-agent-summary').textContent; })()`);
            check(/Haiku 5\.5/.test(summary), width + ': member summary names inherited model: ' + summary);
            await t.click('button', NT.N.next); await t.step(3);
            check(await ev(`/Templates do not save goals or the first task/i.test(document.getElementById('team-start-host').textContent)`), width + ': Start explains template exclusions');
            await t.click('button', NT.N.cancel);
            await TP.seed(ev, team);
            await ev(`window.openTeamPage(${JSON.stringify(team)})`);
            await waitFor(`document.getElementById('team-tab-goals')?.getClientRects().length > 0`, 'team tabs');
            await ev(`window.__statusFetch=window.fetch; window.fetch=(u,o)=>{const p=new URL(String(u),location.href);if(p.pathname===${JSON.stringify('/api/board/'+team+'/status')})return Promise.resolve(Response.json({agents:[{name:'Designer',subscriber_id:'Designer',availability:'available',tasks:[],reason:'Idle'},{name:'Writer',subscriber_id:'Writer',availability:'waiting',tasks:[],reason:'Waiting for another task'}],summary:{total:2,available:1,waiting:1}}));return window.__statusFetch(u,o);};true`);
            await ev(`import(${S}+'team_page.js').then(m=>m.goTab('agents'))`);
            await waitFor(`document.querySelectorAll('#team-panel-agents tbody tr').length===2`, 'two idle agents');
            const idle = await ev(`[...document.querySelectorAll('#team-panel-agents tbody tr')].map(r=>r.textContent)`);
            check(idle.every(x=>x.includes('Waiting for work') && !/\\bFree\\b/.test(x)), width + ': one idle status: '+JSON.stringify(idle));
            await ev(`import(${S}+'team_page.js').then(m=>m.goTab('goals'))`);
            await ev(`window.saveTeamFromSidebar(${JSON.stringify(team)})`);
            await waitFor(`document.getElementById('prompt-modal')?.getClientRects().length > 0`, 'Save template prompt loaded');
            check(await ev(`/Not skills, goals or the first task/i.test(document.getElementById('prompt-modal-label').textContent)`), width + ': Save template explains exclusions');
            await ev(`window.hidePromptModal();true`);
            // A count response arrives after a person scrolls the strip towards another tab.
            await ev(`window.__countReads=0; window.__countBump=false; const rf=window.fetch; window.fetch=(u,o)=>{const p=new URL(String(u),location.href);if(window.__countBump && p.pathname===${JSON.stringify('/api/board/'+team+'/goals')}) { window.__countReads++; return Promise.resolve(Response.json({goals:Array.from({length:9},(_,i)=>({id:i+1,state:'active',title:'Goal '+i}))})); } return rf(u,o);}; true`);
            const before = await ev(`(()=>{const s=document.getElementById('team-tabs');s.scrollLeft=80;window.__countBump=true;return s.scrollLeft;})()`);
            await ev(`document.dispatchEvent(new CustomEvent('coral:team-sleep-changed',{detail:{team:${JSON.stringify(team)}}}));true`);
            await waitFor(`window.__countReads > 0 && document.querySelector('#team-tab-goals .team-tab-count').textContent==='9'`, 'new goal count drawn'); await ev(framesJs(2));
            const after = await ev(`document.getElementById('team-tabs').scrollLeft`);
            check(Math.abs(after-before)<1, width + ': count refresh leaves the strip where the person put it: ' + before + ' -> ' + after);
            // The table's real cell gives touch users the same full names a hover gives.
            const who = await ev(`import(${S}+'tasks_view.js').then(m=>{const c=m.whoCell({status:'in_progress',assigned_to:'Designer',reviewers:['QA Engineer']});const h=document.createElement('div');h.id='walk-who';h.append(c);document.body.append(h);const b=h.querySelector('button');if(b)b.click();return !!b;})`);
            check(who, width + ': Who cell is a button');
            check(await ev(`document.querySelector('#walk-who button')?.getAttribute('aria-label') === 'Designer, review by QA Engineer'`), width + ': Who button has its own accessible name');
            if (who) { await waitFor(`[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('Designer, review by QA Engineer'))`, 'tap shows names'); }
            await ev(`document.getElementById('walk-who')?.remove(); window.__countBump=false; window.T.state.liveSessions=[]; window.T.state.currentSession={type:'live',name:'Other team agent',session_id:'elsewhere'}; true`);
            // Removing this team returns Home even if another chat had been selected earlier.
            await ev(`import(${S}+'message_board.js').then(m=>m.deleteTeam(${JSON.stringify(team)}))`);
            await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length>0`, 'Remove team confirmation');
            await ev(`document.getElementById('confirm-modal-yes').click();true`);
            await waitFor(`fetch('/api/board/projects').then(r=>r.json()).then(p=>!JSON.stringify(p).includes(${JSON.stringify(team)}))`, 'team removed');
            check(await waitFor(`!document.getElementById('team-page-view')?.getClientRects().length`, 'team page closed').then(()=>true,()=>false), width + ': removed team page closes');
            check(await ev(`document.getElementById('welcome-screen').getClientRects().length>0`), width + ': removal lands on Home');
            check(await ev(`location.pathname === '/agents'`), width + ': Home has its own address after removal');
        }
    } finally { await removeBoards(ev, boards).catch(()=>{}); await client.close(); }
    assert.deepEqual(problems, []);
    console.log('PASS walk61 template exclusions, model summary, stable tab scroll, touch Who and removal destination at 768/1280');
})().catch(e=>{console.error(e);process.exitCode=1;});
