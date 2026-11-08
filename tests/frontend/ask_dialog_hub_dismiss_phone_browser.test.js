// #14578: phone Dismiss uses the question computer's owner-gated close route, locally and through the Hub.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {setupHubWorld,BASE}=require('./helpers/hub_world');
const {coralReady}=require('./helpers/wait');
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const hub of [false,true]){
   if(hub)await setupHubWorld({client,Page,Emulation,width:390,height:844,mobile:true,inbox:'native',needs:true});
   else{await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});await Emulation.setTouchEmulationEnabled({enabled:true});}
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');
   assert.equal(await ev(`import((window.__coralStatic||'/static/')+'server_base.js').then(m=>m.isCloud())`),hub,'test runs on the intended page mode');
   const source=hub?'m2':'local',expected=hub?'/api/remote/m2/api/board/release/asks/41/close':'/api/board/release/asks/41/close';
   await ev(`(()=>{const real=window.fetch;window.__dismissWrites=[];window.__dismissRefused=false;window.fetch=(u,o={})=>{const url=new URL(String(u),location.href);if(url.pathname.endsWith('/asks/41/close')){window.__dismissWrites.push({path:url.pathname,query:url.search,method:o.method,body:JSON.parse(o.body)});return Promise.resolve(window.__dismissRefused?Response.json({code:'owner_only',error:'owner_only'},{status:403}):Response.json({ok:true}));}return real(u,o)};return true})()`);
   const open=kind=>ev(`import((window.__coralStatic||'/static/')+'operator_asks.js').then(m=>m.openAskDialog({server:${JSON.stringify(source)},board:'release',kind:${JSON.stringify(kind)},id:41,asker:'Lead',text:'Confirm release',at:new Date().toISOString()},()=>{}))`);
   const button=`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button')].find(b=>b.textContent.trim()==='Dismiss')`;
   await open('ask');await waitFor(`!!(${button})?.getClientRects().length`,'phone question offers Dismiss');
   assert.ok(await ev(`(${button}).getBoundingClientRect().height>=44`),'Dismiss is a phone target');
   await ev(`(${button}).click();true`);await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`,'successful close dismisses the question dialog');
   assert.deepEqual(await ev(`window.__dismissWrites`),[{path:expected,query:'',method:'POST',body:{note:'Dismissed by the operator'}}],'exact source close route and fixed note, no message send');
   await ev(`window.__dismissRefused=true;true`);await open('ask');await ev(`(${button}).click();true`);
   await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-error')?.textContent.includes('owner')`,'owner-only refusal remains readable');
   assert.ok(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open] textarea')`),'refused close keeps reply text box');
   assert.equal(await ev(`(${button})?.hidden`),true,'owner-only refusal hides unavailable Dismiss');
   await ev(`document.querySelector('dialog.inbox-ask-dialog[open]').close();true`);await open('wait');
   assert.equal(await ev(`!!(${button})`),false,'wait has no question-close route');
   await ev(`document.querySelector('dialog.inbox-ask-dialog[open]').close();true`);
  }
  console.log('PASS local and Hub phone Dismiss source routing,44px,owner-only refusal and wait exclusion');
 }finally{await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
