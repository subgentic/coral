// #17030: a completed non-git read is an actionable empty state; selecting Branches keeps its tab visible.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `qa-branches-empty-${Date.now()%100000}`;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {coralReady,framesJs}=require('./helpers/wait');
 const failures=[];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for (const width of [390,1280]) for (const theme of ['light','dark']) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev); await installTP(ev); await seed(ev,TEAM);
   await ev(`(() => { document.documentElement.dataset.theme='${theme}'; const real=window.fetch; window.__branchAnswer={available:true,repos:[],read_state:'done',not_git:true}; window.fetch=(u,o)=>String(u).split('?')[0].endsWith('/branches') ? Promise.resolve(new Response(JSON.stringify(window.__branchAnswer),{status:200,headers:{'Content-Type':'application/json'}})) : real(u,o); })()`);
   await ev(`window.openTeamPage(${JSON.stringify(TEAM)},{tab:'branches'})`);
   await waitFor(`document.getElementById('team-tab-branches')?.getAttribute('aria-selected')==='true'`,'Branches selected'); await ev(framesJs(3));
   const result=await ev(`(()=>{const s=document.getElementById('team-tabs'),t=document.getElementById('team-tab-branches'),p=document.getElementById('team-panel-branches'),r=s.getBoundingClientRect(),b=t.getBoundingClientRect(),c=getComputedStyle(t);return {text:p.textContent,whole:b.left>=r.left-1&&b.right<=r.right+1,mark:c.borderBottomColor!==getComputedStyle(document.getElementById('team-tab-goals')).borderBottomColor,padding:parseFloat(getComputedStyle(p).paddingLeft),cue:s.dataset.more||''};})()`);
   if (process.env.CORAL_SCREENSHOT_DIR) {fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/branches-${width}-${theme}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   if(!/This folder is not under git, so there are no branches or changes/.test(result.text)||!/git init/.test(result.text)) failures.push(`${width}/${theme}: non-git explanation missing: ${result.text}`);
   if(!result.whole||!result.mark||result.padding<12) failures.push(`${width}/${theme}: selected tab/layout ${JSON.stringify(result)}`);
   for(const answer of [{available:true,repos:[]},{available:true,repos:[],read_state:'pending',not_git:false}]) {
    await ev(`(async()=>{window.__branchAnswer=${JSON.stringify(answer)}; const m=await import((window.__coralStatic||'/static/')+'branches_tab.js'); await m.showTeamBranches(document.getElementById('team-panel-branches'),${JSON.stringify(TEAM)});})()`);
    assert.match(await ev(`document.getElementById('team-panel-branches').textContent`),/Reading/,'unknown and pending are not reported as non-git');
   }
  }
  assert.deepEqual(failures,[]);
 } finally {await removeBoards(ev,[TEAM]).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
