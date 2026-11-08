// #14143: native Hub team Needs you reuses protected review paging and source-qualified question actions.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {setupHubWorld,BASE}=require('./helpers/hub_world');
const {coralReady}=require('./helpers/wait');
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try{
  await setupHubWorld({client,Page,Emulation,width:1280,height:900,mobile:false,inbox:'native',needs:true,hubPages:true});
  await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','liveListLoaded','settings');
   await ev(`(()=>{window.__teamRemoteReads=[];window.__teamRemoteWrites=[];window.__replyRefused=true;window.__questionOpen=true;const real=window.fetch;const json=(body,status=200)=>Promise.resolve(Response.json(body,{status}));const files=Array.from({length:52},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:'file-'+i+'.txt',produced_by:'Writer '+i,available:true,tags:['for review'],created_at:'2026-11-07T01:00:00Z'}));window.fetch=(u,o={})=>{const url=new URL(String(u),location.href),match=url.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/);if(!match){if(url.pathname==='/api/sessions/live'&&window.__teamLiveRows)return json({sessions:window.__teamLiveRows});return real(u,o);}const server=match[1],path=match[2];window.__teamRemoteReads.push({server,path,query:url.search});if(o.method&&o.method!=='GET')window.__teamRemoteWrites.push({server,path,body:JSON.parse(o.body||'{}')});if(path==='/api/team-artifacts')return json(window.__reviewFixturePage(url.href,location.href,{'same-team':{team:'Release team',artifacts:server==='m2'?files:[{...files[0],name:'WRONG COMPUTER FILE'}]}}));if(path==='/api/operator-asks')return json(server==='m2'?(window.__questionOpen?[{kind:'ask',id:41,board:'same-team',board_label:'Release team',asker:'Remote lead',text:'Please confirm remote plan',at:'2026-11-07T01:00:00Z'}]:[]):[{kind:'ask',id:41,board:'same-team',asker:'Other lead',text:'WRONG COMPUTER QUESTION',at:'2026-11-07T01:00:00Z'}]);if(path==='/api/proposals')return json({proposals:[]});if(path==='/api/board/same-team/status')return json({agents:[{availability:'needs_input',session_id:'remote-wait-id'}]});if(path==='/api/board/same-team/goals')return json({goals:[]});if(path==='/api/board/same-team/messages'&&o.method==='POST'){if(window.__replyRefused)return json({error:'owner only'},403);window.__questionOpen=false;return json({id:42});}return real(u,o)};return true})()`);
   await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.hub=true;state.servers=window.__computers;const row={name:'remote-wait',session_id:'remote-wait-id',display_name:'Remote waiting agent',agent_type:'claude',server:'m2',board_project:'same-team',sleeping:false,waiting_for_input:true,wait_ignored:true,waiting_kind:'permission',waiting_summary:'A terminal prompt',waiting_since:'2026-11-07T01:00:00Z'};state.liveSessions=window.__teamLiveRows=[row,{...row,server:'m1',display_name:'WRONG COMPUTER AGENT'}];})`);
   await ev(`window.openTeamPage('@m2/same-team',{tab:'needs'})`);
   await waitFor(`location.pathname==='/team/@m2/same-team/needs'&&document.querySelector('#team-panel-needs')?.textContent.includes('Remote waiting agent')`,'remote team route and waiting row',12000);
   await waitFor(`document.querySelector('#team-panel-needs')?.textContent.includes('Please confirm remote plan')`,'remote team question').catch(async error=>{const diagnostic=await ev(`import((window.__coralStatic||'/static/')+'operator_asks.js').then(m=>({asks:m.operatorAsks(),reads:window.__teamRemoteReads.filter(read=>read.path==='/api/operator-asks'),text:document.querySelector('#team-panel-needs')?.textContent.slice(0,900)}))`);throw new Error(error.message+' '+JSON.stringify(diagnostic));});
   assert.equal(await ev(`/WRONG COMPUTER/.test(document.querySelector('#team-panel-needs').textContent)`),false,'same-named other computer does not leak rows');
   assert.equal(await ev(`!!document.querySelector('#team-panel-needs tr[data-key="m2:remote-wait-id"] .inbox-remove-wait')`),false,'local-only terminal removal is not offered remotely');
   const files=()=>ev(`[...document.querySelectorAll('#team-panel-needs tbody tr[data-key]')].filter(row=>/file-\\d+\\.txt/.test(row.textContent)).length`);
   await waitFor(`[...document.querySelectorAll('#team-panel-needs tbody tr[data-key]')].filter(row=>/file-\\d+\\.txt/.test(row.textContent)).length===50`,'first protected team review page');
   await waitFor(`!![...document.querySelectorAll('#team-panel-needs .inbox-more-files button')].find(button=>button.textContent==='Show more')`,'shared review paging footer');
   await ev(`[...document.querySelectorAll('#team-panel-needs .inbox-more-files button')].find(button=>button.textContent==='Show more').click();true`);
   await waitFor(`[...document.querySelectorAll('#team-panel-needs tbody tr[data-key]')].filter(row=>/file-\\d+\\.txt/.test(row.textContent)).length===52`,'second protected review page');
   assert.equal(await files(),52);
   const scoped=await ev(`window.__teamRemoteReads.filter(read=>read.path==='/api/team-artifacts'&&new URLSearchParams(read.query).get('team')==='same-team')`);
   assert.ok(scoped.length>1&&scoped.every(read=>read.server==='m2'),'scoped paging/count reads only the selected computer');
   await ev(`document.querySelector('#team-panel-needs .inbox-ask-name').click();true`);
   await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-box')`,'shared question dialog');
   await ev(`(()=>{const box=document.querySelector('dialog.inbox-ask-dialog .inbox-ask-box');box.value='Confirmed';box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('dialog.inbox-ask-dialog .inbox-ask-send').click();return true})()`);
   await waitFor(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-error')?.textContent.includes('owner only')`,'source refusal keeps reply visible');
   assert.equal(await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-box').value`),'Confirmed','403 preserves typed reply');
   await ev(`window.__replyRefused=false;document.querySelector('dialog.inbox-ask-dialog .inbox-ask-send').click();true`);
   await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`,'successful source reply closes shared dialog');
   const writes=await ev(`window.__teamRemoteWrites`);
   assert.equal(writes.length,2);assert.ok(writes.every(write=>write.server==='m2'&&write.path==='/api/board/same-team/messages'&&write.body.reply_to===41),'question replies retain computer, team and message identity');
   assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`),true,'remote team list fits viewport');
  }
  console.log('PASS Hub team Needs you: qualified rows/counts, protected paging, reply403 and source-only success at desktop/phone');
 }finally{await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
