// A custom mode is a choice by ID: saving and reopening a member must not broaden it to the team's Auto.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {install:installNT,M,T,N,openNewTeam,stubModels}=require('./helpers/new_team');
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {coralReady}=require('./helpers/wait').bind(ev);
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:process.env.CORAL_TEST_URL+'/'});await Page.loadEventFired();await install();await coralReady();await installNT(ev);await stubModels(ev);
  const created=await ev(`fetch('/api/custom-modes',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({modes:[{name:'Edits ok',agent_type:'claude',flags:['--permission-mode','acceptEdits']}]})}).then(async r=>({status:r.status,body:await r.json()}))`);
  assert.equal(created.status,200,JSON.stringify(created));
  await ev(`import((window.__coralStatic||'/static/')+'custom_modes.js').then(m=>m.warmCustomModes(true)).then(()=>true)`);
  const mode=await ev(`import((window.__coralStatic||'/static/')+'state.js').then(m=>'custom:'+m.state.customModes.find(x=>x.name==='Edits ok').id)`);
  await ev(`localStorage.setItem('coral-recent-dirs',JSON.stringify(['/tmp']));true`);
  await openNewTeam(ev,waitFor);const team=T(ev,waitFor),member=M(ev,waitFor);await team.to(2,{folder:'/tmp',template:/Coding/});
  await ev(`(()=>{const s=document.getElementById('team-permission-mode');s.value='auto';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  const open=async()=>{await ev(`(()=>{const row=[...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r=>r.textContent.includes('QA Engineer'));row.querySelector('.team-agent-edit-btn').click();return true;})()`);await waitFor(`!!window.__nt.dlg(${N.member})`,'Edit QA Engineer');await member.section('Permissions');};
  await open();await waitFor(`[...document.querySelector('#launch-agent-acf .acf-permission-mode').options].some(o=>o.value===${JSON.stringify(mode)})`,'custom option');
  await ev(`(()=>{const s=document.querySelector('#launch-agent-acf .acf-permission-mode');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);await member.save();
  const row=await ev(`(()=>{const r=[...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r=>r.textContent.includes('QA Engineer'));return {text:r.querySelector('.team-agent-summary').textContent,mode:window.getAgentConfig(r.dataset.acfId).permissionMode};})()`);
  assert.equal(row.mode,mode,'Save member retains the custom ID instead of Default');assert.match(row.text,/Edits ok/,'summary names the selected mode');
  await open();assert.equal(await ev(`document.querySelector('#launch-agent-acf .acf-permission-mode').value`),mode,'reopening retains custom selection');await member.save();
  await ev(`(()=>{const real=fetch;window.__teamLaunch=[];window.fetch=(u,o={})=>{if(new URL(String(u),location.origin).pathname==='/api/sessions/launch-team'){__teamLaunch.push(JSON.parse(o.body));return Promise.resolve(new Response(JSON.stringify({error:'Stopped by test'}),{status:400,headers:{'Content-Type':'application/json'}}));}return real(u,o);};return true;})()`);
  await team.click('button',N.launch);/* New team is two steps (LT1, #15892): step 2 of 2 has Launch, no Next */await waitFor(`__teamLaunch.length===1`,'team launch request');
  const sent=await ev(`__teamLaunch[0].agents.find(a=>a.name==='QA Engineer')`);assert.equal(sent.permission_mode,mode,'launch names custom member mode');assert.ok(!sent.flags||!sent.flags.includes('auto'),'member does not send Auto flags');
  console.log('PASS custom member mode survives save, summary, reopen and team launch');
 }finally{await ev(`fetch('/api/custom-modes',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"modes":[]}'}).then(()=>true)`).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
