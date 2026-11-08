// The Hub-only owner reads the opened computer's own notice, never a shell copy.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
(async()=>{
 const {client,Page,Emulation,ev,waitFor}=await connect();
 try {
  await setupHubWorld({client,Page,Emulation,width:1280,height:900,mobile:false,inbox:true});
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{const real=window.fetch;window.__noticeCalls=[];window.__noticeReply={status:200,body:{id:'server-owned-version',text:'Laptop server notice <b>with full authority</b>.',seen:true}};window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(p.endsWith('/api/launch-disclosure')){window.__noticeCalls.push({path:p,method:o.method||'GET'});return Promise.resolve(Response.json(window.__noticeReply.body,{status:window.__noticeReply.status}));}return real(u,o)};})()`});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','settings');
   await ev(`window.switchNavTab('servers');true`);
   await waitFor(`!!document.querySelector('#server-row-m1 .cs-open')`,'Hub computer list');
   const open=()=>ev(`document.querySelector('#server-row-m1 .cs-open').click();true`);
   const back=()=>ev(`document.getElementById('servers-back').click();true`);
   await open();
   await waitFor(`document.querySelector('.cs-launch-disclosure')?.textContent.includes('Laptop server notice')`,'server-owned notice on computer page');
   const notice=await ev(`(()=>{const n=document.querySelector('.cs-launch-disclosure');return{text:n.textContent,markup:!!n.querySelector('b'),overflow:n.scrollWidth-n.clientWidth}})()`);
   assert.match(notice.text,/Settings.*Agents.*Default permission mode/,'names where to lower default on that computer');
   assert.match(notice.text,/Shown here for information.*Acknowledge this notice in Coral on this computer/,'information-only and local acknowledgement are explicit');
   assert.equal(notice.markup,false,'notice text never becomes HTML');assert.ok(notice.overflow<=1,'notice wraps on phone');
   assert.deepEqual(await ev('window.__noticeCalls'),[{path:'/api/remote/m1/api/launch-disclosure',method:'GET'}],'reads only opened computer, no acknowledgement even if already seen');
   await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'cloud_server_view.js');m.serverView.render();m.serverView.render();return true})()`);
   assert.equal(await ev('window.__noticeCalls.length'),1,'redraws reuse the same read');
   for(const status of [403,404,503]){
    await back();await ev(`window.__noticeReply={status:${status},body:{id:'private',text:'PRIVATE REFUSED NOTICE'}};true`);await open();
    await waitFor(`window.__noticeCalls.length===${status===403?2:status===404?3:4}`,'refused read settled');
    assert.equal(await ev(`document.querySelector('.cs-launch-disclosure')?.textContent.includes('PRIVATE')||false`),false,'refused/old/offline endpoint reveals no body');
   }
   await back();await ev(`window.__noticeReply={status:200,body:{text:'missing version'}};true`);await open();
   await waitFor(`window.__noticeCalls.length===5`,'malformed read');
   assert.equal(await ev(`document.querySelector('.cs-launch-disclosure')?.textContent||''`),'','malformed notice omitted');
  }
  console.log('PASS Hub computer notice: server text, owner refusal, no writes, desktop and phone');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
