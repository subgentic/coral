// #14312: explicit removal hides only the current dismissed request and sends no input.
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
   await ev(`(()=>{localStorage.removeItem('coral-inbox-needs-filters');const real=window.fetch;window.__waitWrites=[];window.__m.add('retained-agent','R',3,{sleeping:false});const row=window.T.state.liveSessions.find(s=>s.session_id==='retained-agent-id');Object.assign(row,{board_project:${JSON.stringify(team)},waiting_for_input:true,wait_ignored:true,waiting_kind:'permission',waiting_summary:'Browser permission',waiting_since:'2026-11-07T01:00:00Z'});window.__retained=row;window.T.state.liveSessions.push({...row,server:'box-2',session_id:'remote-retained-id',name:'remote-retained',display_name:'Remote retained agent'});window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(o.method&&o.method!=='GET')window.__waitWrites.push(p);if(p==='/api/board/'+${JSON.stringify(team)}+'/status'&&window.__failAvailability){window.__availabilityFailed=true;return Promise.resolve(Response.json({error:'unavailable'},{status:503}));}if(p==='/api/board/'+${JSON.stringify(team)}+'/status')return Promise.resolve(Response.json({agents:[{session_id:'retained-agent-id',availability:${JSON.stringify(width===1280?'needs_input':'waiting')}}]}));if(p==='/api/sessions/live')return Promise.resolve(Response.json(window.T.state.liveSessions));return real(u,o)};window.T.render.renderLiveSessions(window.T.state.liveSessions);window.__opened=null;window.selectLiveSession=(...args)=>{window.__opened=args};return true})()`);
   const count=()=>ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.waitingCount())`);
   await ev(`(()=>{const real=window.fetch;window.__removeStatus=200;window.__removeCalls=[];window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(p.endsWith('/dismiss-wait')){const body=JSON.parse(o.body);window.__removeCalls.push(body);if(window.__removeStatus!==200)return Promise.resolve(Response.json({error:window.__removeStatus===409?'Dismiss it first':'Only the owner may remove it'},{status:window.__removeStatus}));window.__retained.wait_removed=true;return Promise.resolve(Response.json({removed:true}));}return real(u,o)};return true})()`);
   const inbox=async()=>{await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);await waitFor(`!!document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"]')`,'current retained row');};
   const remove=async()=>{
    if(width===1280){await waitFor(`!!document.querySelector('.inbox-remove-wait')`,'desktop Remove action');await ev(`document.querySelector('.inbox-remove-wait').click();true`);}
    else{await ev(`document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"] [aria-label*="More"]').click();true`);await waitFor(`!![...document.querySelectorAll('[role=menuitem],.menu-item')].find(e=>e.textContent.trim()==='Remove from Needs you')`,'phone Remove menu item');await ev(`[...document.querySelectorAll('[role=menuitem],.menu-item')].find(e=>e.textContent.trim()==='Remove from Needs you').click();true`);}
   };
   await inbox(); assert.equal(await count(),2,'both requests count before removal');
   for(const status of [403,409]){await ev(`window.__removeStatus=${status};true`);await remove();await waitFor(`window.__removeCalls.length===${status===403?1:2}`,'refused removal sent');await waitFor(`document.body.textContent.includes('${status===403?'Only the owner may remove it':'Dismiss it first'}')`,'server refusal wording');assert.equal(await count(),2,'refusal retains count');assert.equal(await ev(`!!document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"]')`),true,'refusal retains row');}
   await ev(`window.__removeStatus=200;true`);await remove();
   await waitFor(`!document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"]')`,'successful removal drops only local request');
   assert.equal(await count(),1,'removed request leaves Inbox count; remote request remains');
   assert.deepEqual(await ev(`import((window.__coralStatic||'/static/')+'dismiss_wait.js').then(m=>[m.canRemoveWait({...window.__retained,waiting_since:''}),m.canRemoveWait({...window.__retained,wait_ignored:false}),m.canRemoveWait({...window.__retained,wait_removed:true}),m.canRemoveWait({...window.__retained,server:'box-2'})])`),[false,false,false,false],'no Remove for unbounded, undismissed, already removed or remote-owner-unknown requests');
   assert.deepEqual((await ev('window.__removeCalls')).at(-1),{session_id:'retained-agent-id',agent_type:'claude',remove:true},'exact removal contract');
   await ev(`window.openTeamPage(${JSON.stringify(team)})`);
   await waitFor(`document.querySelector('#team-page-status')?.textContent.trim()==='All well'`,'team count agrees that local request was removed');
   await ev(`window.__retained=window.T.state.liveSessions.find(s=>s.session_id==='retained-agent-id');window.__retained.wait_removed=false;window.__retained.wait_ignored=false;window.__retained.waiting_since='2026-11-07T02:00:00Z';window.T.render.renderLiveSessions(window.T.state.liveSessions);true`);
   await inbox();assert.equal(await count(),2,'a new request is counted again');
   assert.equal(await ev(`!!document.querySelector('.inbox-remove-wait')`),false,'new undismissed request has no Remove button');
   assert.deepEqual(await ev(`window.__waitWrites.filter(p=>['send','keys','input','answer-prompt'].includes(p.split('/').pop()))`),[],'removal sends no answer');
  }
  console.log('PASS explicit wait removal, refused writes, shared counts and next request at desktop/phone');
 } finally { await removeBoards(ev,teams).catch(()=>{});await client.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
