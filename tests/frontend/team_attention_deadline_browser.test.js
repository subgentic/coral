// #16396: attention reconciliation expires without another successful poll after Wake/Reset.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const {removeBoards}=require('./helpers/board_cleanup');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const teams=[];
 const shot=async name=>{const dir=process.env.CORAL_SCREENSHOT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/'+name+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}};
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   const B='attention-deadline-'+Date.now().toString(36);teams.push(B);
   await ev(`fetch('/api/board/${B}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Boss',job_title:'Orchestrator'})}).then(r=>r.ok)`);
   await ev(`(()=>{globalThis.__coralAttentionGraceMs=500;const real=window.fetch;window.__attentionReads=0;window.fetch=(u,o)=>{if(new URL(String(u),location.href).pathname==='/api/board/${B}/status'){window.__attentionReads++;if(window.__attentionReads>1)return new Promise(()=>{});return Promise.resolve(Response.json({agents:[{session_id:'unmatched-sid',availability:'needs_input'}]}));}return real(u,o)};return true})()`);
   await ev(`window.openTeamPage('${B}',{tab:'goals'}).then(()=>true)`);
   await waitFor(`document.getElementById('team-page-status')?.textContent==='Checking attention status'`,'Checking while rows reconcile');await shot('checking-'+width);
   await waitFor(`/^1 needs? attention$/.test(document.getElementById('team-page-status')?.textContent||'')`,'attention deadline settles without another read',1600);
   await shot('settled-'+width);assert.ok(await ev(`!document.getElementById('team-page-health').hidden`),'health action available after deadline');
  }
  console.log('PASS deadline settles attention independently at desktop/390');
 } finally {await removeBoards(ev,teams).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
