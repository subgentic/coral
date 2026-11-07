// #14152: Dismiss sends nothing; an active terminal wait remains reachable and counted.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const teams=[];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width===390 });
   await Page.navigate({ url: BASE+'/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
   const team='retained-wait-'+Date.now().toString(36);teams.push(team);
   await ev(`fetch('/api/board/'+${JSON.stringify(team)}+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Retained agent',job_title:'Developer'})}).then(r=>r.ok)`);
   await ev(`(()=>{localStorage.removeItem('coral-inbox-needs-filters');const real=window.fetch;window.__waitWrites=[];window.__m.add('retained-agent','R',3,{sleeping:false});const row=window.T.state.liveSessions.find(s=>s.session_id==='retained-agent-id');Object.assign(row,{board_project:${JSON.stringify(team)},waiting_for_input:true,wait_ignored:true,waiting_kind:'permission',waiting_summary:'Browser permission',waiting_since:'2026-11-07T01:00:00Z'});window.__retained=row;window.T.state.liveSessions.push({...row,server:'box-2',session_id:'remote-retained-id',name:'remote-retained',display_name:'Remote retained agent'});window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(o.method&&o.method!=='GET')window.__waitWrites.push(p);if(p==='/api/sessions/live')return Promise.resolve(Response.json(window.T.state.liveSessions));return real(u,o)};window.T.render.renderLiveSessions(window.T.state.liveSessions);window.__opened=null;window.selectLiveSession=(...args)=>{window.__opened=args};return true})()`);
   await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
   const count=()=>ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.waitingCount())`);
   assert.equal(await count(),2,width+': both computers retain active ignored waits');
   await waitFor(`document.querySelector('#group-table-view')?.textContent.includes('Still waiting in its terminal')`,'retained wait explanation');
   await waitFor(`!!document.querySelector('#group-table-view .inbox-open-agent')`,'Open agent remains available');
   assert.equal(await ev(`document.querySelectorAll('#group-table-view .inbox-answer, #group-table-view .inbox-dismiss').length`),0,'no stale answers or repeat Dismiss');
   await ev(`window.openTeamPage(${JSON.stringify(team)})`);
   await waitFor(`document.querySelector('#team-page-health')?.textContent.includes('1 needs attention')`,'team status counts the same retained wait');
   await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
   await waitFor(`!!document.querySelector('#group-table-view .inbox-open-agent')`,'return to retained row');
   await ev(`document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"] .inbox-open-agent').click();true`);
   assert.deepEqual((await ev(`window.__opened`)).slice(0,3),['retained-agent','claude','retained-agent-id']);
   assert.deepEqual(await ev(`window.__waitWrites.filter(p=>['send','keys','input','answer-prompt'].includes(p.split('/').pop()))`),[],'opening the agent sends no answer');
   await ev(`window.__retained.waiting_for_input=false;window.T.render.renderLiveSessions(window.T.state.liveSessions);true`);
   assert.equal(await count(),1,'agent evidence clears the local wait while the remote same-team wait stays');
  }
  console.log('PASS retained terminal waits remain explained, counted and reachable until agent evidence clears them');
 } finally { await removeBoards(ev,teams).catch(()=>{});await client.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
