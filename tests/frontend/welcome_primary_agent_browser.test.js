// #16595: one clear first action on a fresh Inbox, with the permission notice at launch.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(()=>{const real=window.fetch;window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;const json=b=>Promise.resolve(Response.json(b));if(p==='/api/board/projects')return json([]);if(p==='/api/launch-disclosure')return json({id:'qa-notice',text:'Agents can act without asking.',seen:false});if(p==='/api/settings'&&o.method==='PUT')return json({ok:true});return real(u,o)};window.T.state.settings={...window.T.state.settings,inbox_welcome:'on',inbox_welcome_done:''};window.T.state.liveSessions=[];window.T.state.servers=[];window.switchNavTab('hub-inbox');return true})()`);
   await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>{m.updateInboxTab();return m.selectInboxTab('needs')}).then(()=>true)`);
   await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-actions').length===5`,'five Welcome actions');
   const got=await ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-actions')].map(e=>({text:e.querySelector('.inbox-main-action').textContent,primary:e.querySelector('.inbox-main-action').classList.contains('btn-primary')}))`);
   assert.equal(got[0].text,'New agent','Start your first agent is first');assert.deepEqual(got.filter(a=>a.primary).map(a=>a.text),['New agent'],'one primary action');
   await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure()).then(()=>true)`);
   assert.equal(await ev(`!!document.getElementById('launch-disclosure-banner')`),false,'no auto-mode banner without any agents');
   // Open the first action before a live agent makes that completed Welcome item disappear.
   await ev(`document.querySelector('#group-table-view .inbox-welcome-actions .inbox-main-action').click();true`);
   await waitFor(`document.getElementById('launch-modal')?.getClientRects().length>0`,'New agent opens launch');await ev(`window.hideLaunchModal();true`);
   await ev(`window.T.state.liveSessions=[{session_id:'qa-agent',name:'First agent',server:'local'}];window.dispatchEvent(new Event('coral:live-list-rendered'));true`);
   await waitFor(`!!document.getElementById('launch-disclosure-banner')`,'notice available after first agent');
   await ev(`window.T.state.liveSessions=[];window.dispatchEvent(new Event('coral:live-list-rendered'));true`);
   await waitFor(`!document.getElementById('launch-disclosure-banner')`,'notice removed without local agents');

  }
  console.log('PASS Welcome starts with its only primary New agent; no pre-agent banner');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
