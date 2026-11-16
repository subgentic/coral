// #16396, reshaped by #17625 item 3 (the Orchestrator's decision on #18820): the header shows the Needs you number, so there is no grace period to expire any more. When the board's status read stalls after its first answer (Wake/Reset),
// the header still settles on the tab's count with no further read, and does not stay on 'Checking attention status'.
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
   await ev(`(()=>{const real=window.fetch;window.__attentionReads=0;window.fetch=(u,o)=>{if(new URL(String(u),location.href).pathname==='/api/board/${B}/status'){window.__attentionReads++;if(window.__attentionReads>1)return new Promise(()=>{});return Promise.resolve(Response.json({agents:[{session_id:'unmatched-sid',availability:'needs_input'}]}));}if(new URL(String(u),location.href).pathname==='/api/team-artifacts')return Promise.resolve(Response.json({total:1,items:[],partial:false,truncated:false,failed_boards:[]}));return real(u,o)};return true})()`);
   await ev(`window.openTeamPage('${B}',{tab:'goals'}).then(()=>true)`);
   await waitFor(`/^1 needs? attention$/.test(document.getElementById('team-page-status')?.textContent||'')`,'the header settles on the Needs you count with the status read stalled',4000);
   await shot('settled-'+width);
   assert.equal(await ev(`document.querySelector('#team-tab-needs .team-tab-count')?.textContent`),'1','the tab says the same number as the header');
   assert.ok(await ev(`!document.getElementById('team-page-health').hidden`),'health action available once settled');
  }
  console.log('PASS the header settles on the Needs you count without another status read at desktop/390');
 } finally {await removeBoards(ev,teams).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
