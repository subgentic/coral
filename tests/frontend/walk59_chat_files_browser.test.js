// #17280: a CSV route visible in chat, plain Send options, uploaded snapshot time
// and an explicit newest-version link. 1600 light and 390 light, one suite.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const {H1,STUB} = require('./helpers/artifact_versions_stub');
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const shot=require('./helpers/scene_shots')(Page), team='walk59-'+Date.now().toString(36);
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1600,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width<600});
   await Page.navigate({url:BASE});await Page.loadEventFired();await install();await require('./helpers/wait').coralReady(ev);
   await ev(`document.documentElement.setAttribute('data-theme','light');window.__m.add('walk59-mate','M',3,{sleeping:false,board_project:'${team}'});true`);
   await waitFor(`!!T.state.liveSessions.find(s=>s.name==='walk59-mate')`,'team agent in list',10000);
   await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Boss',job_title:'Orchestrator',session_name:'boss-${team}'})}).then(()=>true)`);
   await ev(`window.selectLiveSession('walk59-mate','claude','walk59-mate-id','local');true`);
   await waitFor(`T.state.currentSession?.name==='walk59-mate'&&!![...document.querySelectorAll('[data-on-click="cmd-send-menu"]')].find(e=>e.getClientRects().length)`,'chat composer ready',10000);
   await ev(`[...document.querySelectorAll('[data-on-click="cmd-send-menu"]')].find(e=>e.getClientRects().length).click();true`);
   await shot('walk59-chat-'+width);
   const hint=await ev(`(()=>{const e=document.getElementById('composer-other-files');return e&&!e.hidden&&e.getClientRects().length>0})()`);
   const words=await ev(`[...document.querySelectorAll('.send-menu-item')].filter(e=>e.getClientRects().length).map(e=>e.textContent).join(' ')`);
   await ev(`window.closeSendMenu();true`);
   await ev(STUB);
   await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m=>m.openArtifactViewer('${H1}',{filename:'release-plan.md',createdAt:'2026-11-01T10:00:00Z'})).then(()=>true)`);
   await waitFor(`!!document.querySelector('#artifact-viewer .av-newer')`,'newest-version link',12000);
   await shot('walk59-snapshot-'+width);
   assert.ok(hint,'chat points to Artifacts > Add files for CSV/text');
   assert.ok(!/Team Reminder|Resend Prompt|Board Protocol/.test(words),words);
   assert.match(words,/Send and remind about team messages/);
   if(width===1600)assert.match(words,/Send starting instructions again/);
   const old=await ev(`document.querySelector('.artifact-viewer-snapshot')?.textContent`);
   assert.match(old,/Uploaded snapshot.*\d/);assert.match(old,/Source-file changes are not copied here/);
   await ev(`document.querySelector('#artifact-viewer .av-newer').click();true`);
   await waitFor(`document.querySelector('#artifact-viewer .av-current')?.textContent.includes('v3 of 3')`,'newest uploaded snapshot opens',10000);
   assert.notEqual(await ev(`document.querySelector('.artifact-viewer-snapshot').textContent`),old,'newest version carries its own upload time');
   await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click();document.querySelector('[data-on-click="chat-team-files"]').click();true`);
   await waitFor(`location.pathname.includes('/${team}/artifacts')`,'chat link opens this team Artifacts',10000);
   await waitFor(`!!document.querySelector('#team-panel-artifacts .share-drop-add')`,'Add files available for arbitrary files',10000);
   await shot('walk59-add-files-'+width);
  }
  console.log('PASS chat file route, plain Send words and snapshot/newest version at 1600/390');
 }finally{await ev(`fetch('/api/board/${team}',{method:'DELETE'}).then(r=>r.status)`).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
