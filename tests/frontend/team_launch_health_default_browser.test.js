// #14122: new-team Health check starts on; only an explicit opt-out overrides server defaults.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {install:installNT,N,T,openNewTeam,stubModels}=require('./helpers/new_team');
const {coralReady}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const t=T(ev,waitFor);
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390])for(const optOut of [false,true]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await installNT(ev);await stubModels(ev);
   await ev(`(()=>{localStorage.setItem('coral-recent-dirs',JSON.stringify(['/work/payments-app']));window.__healthLaunch=[];const old=window.fetch;window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(p==='/api/sessions/launch-team'&&o.method==='POST'){window.__healthLaunch.push(JSON.parse(o.body));return Promise.resolve(Response.json({ok:true,board_id:'health-launch-fixture',agents:[],launched:[]}));}if(p==='/api/board/health-launch-fixture/settings'&&o.method==='PUT')return Promise.resolve(Response.json({ok:true}));return old(u,o);};return true;})()`);
   await openNewTeam(ev,waitFor);await t.to(2,{template:/^Blank/});await t.click('button',N.addOrch);await t.click('button',N.next);await t.step(3);
   await ev(`(()=>{const d=window.__nt.dlg(${N.team});const tab=[...d.querySelectorAll('[role=tab]')].filter(window.__na.vis).find(e=>window.__na.name(e)==='Health check');if(tab)tab.click();else{const select=window.__nt.find(d,'select',${N.section});select.value=[...select.options].find(o=>o.textContent.trim()==='Health check').value;select.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()`);
   const box=`window.__nt.find(window.__nt.dlg(${N.team}),'input',/^Send health check/i)`;
   await waitFor(`!!(${box})`,'Health check checkbox');
   assert.equal(await ev(`(${box}).checked`),true,width+': health starts ticked');
   if(optOut)await ev(`(${box}).click();true`);
   await t.click('button',N.launch);await waitFor(`window.__healthLaunch.length===1`,'launch request');
   const request=await ev(`window.__healthLaunch[0]`);
   if(optOut)assert.equal(request.health_monitor,false,'explicit opt-out is sent');
   else assert.equal(Object.hasOwn(request,'health_monitor'),false,'default uses server default without an override');
   await waitFor(`!window.__nt.dlg(${N.team})`,'launch closes dialog');
  }
  console.log('PASS team launch defaults Health check on and sends only explicit false at desktop/phone');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
