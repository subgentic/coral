// Walk 60 (#17300): at 150% zoom on a 1280x800 laptop (853 x 533 CSS px) the plan question's reply box and Send reply sat below the fold behind Close and Dismiss.
// The reply row is the sticky one at the foot of the visible area on a short window too, not only under 600 px wide (#17241).
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect(),failures=[];
 const check=(ok,m)=>{if(!ok)failures.push(m);};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const [width,height] of [[853,533],[700,600],[1024,640]]){
   await Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1.5,mobile:false});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await ev(`window.switchNavTab('hub-inbox');true`);
   await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'operator_asks.js');await m.openAskDialog({board:'release-team',board_label:'Release team',asker:'Orchestrator',kind:'ask',id:77,at:new Date().toISOString(),text:'@Operator Plan: '+('Today each browser keeps its own record, and a question read on the laptop can still show as unread on the phone. ').repeat(14)+'Which option should we use?',buttons:[{id:1,label:'Keep browser-only',action:'reply',state:'pending'},{id:2,label:'Store on Hub',action:'reply',state:'pending'}]},()=>{},{goal(){},task(){}});return true;})()`);
   await waitFor(`document.querySelector('.inbox-ask-dialog .ac-add-image')`,'dialog ready');await ev(framesJs(2));
   await ev(`(()=>{const d=document.querySelector('.inbox-ask-dialog');d.scrollTop=0;for(const e of d.querySelectorAll('*')) if(e.scrollTop) e.scrollTop=0;return true;})()`);
   const p=await ev(`(()=>{const d=document.querySelector('.inbox-ask-dialog'),s=d.querySelector('.inbox-ask-send'),b=d.querySelector('.inbox-ask-box'),r=e=>{const x=e.getBoundingClientRect();return {y:x.top,bottom:x.bottom}};return {send:r(s),box:r(b),vh:innerHeight}})()`);
   const at=`${width}x${height}: `;
   check(p.send.bottom<=p.vh+1&&p.send.y>=0,at+'Send reply is on screen with the question at the top: '+JSON.stringify(p));
   check(p.box.bottom<=p.vh+1,at+'the reply box is on screen: '+JSON.stringify(p));
   await ev(`document.querySelector('.inbox-ask-dialog').close();true`);
  }
  assert.deepEqual(failures,[],failures.join('\n'));console.log('PASS zoom150_ask_reply_browser');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
