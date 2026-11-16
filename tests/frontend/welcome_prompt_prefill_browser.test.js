// #18119: only the two Inbox guide entry points prefill; ordinary launches stay blank.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const {install:installTeam,stubModels}=require('./helpers/new_team');
const BASE=require('./test_base').BASE;
const fs=require('node:fs'),path=require('node:path');
const {setTheme}=require('./helpers/contrast');
const before=process.env.CORAL_GUIDE_BEFORE==='1';
const shots=process.env.CORAL_GUIDE_SHOTS; if(shots)fs.mkdirSync(shots,{recursive:true});
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();try{
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
 for(const width of [1280,390])for(const theme of ['light','dark']){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await installTeam(ev);await stubModels(ev);await setTheme(ev,theme);
 await ev(`(()=>{const real=window.fetch;window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(p==='/api/sessions/launch'||p==='/api/sessions/launch-team'){window.__guideLaunch={path:p,body:JSON.parse(o.body)};return Promise.resolve(Response.json({error:'Test intercepted launch; no agent started'},{status:400}));}if(p==='/api/board/projects')return Promise.resolve(Response.json([]));if(p==='/api/settings'&&o.method==='PUT')return Promise.resolve(Response.json({ok:true}));return real(u,o)};window.T.state.settings={...window.T.state.settings,inbox_welcome:'on',inbox_welcome_done:''};window.T.state.liveSessions=[];window.T.state.servers=[];window.switchNavTab('hub-inbox');return true})()`);
 await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>{m.updateInboxTab();return m.selectInboxTab('needs')}).then(()=>true)`);
 await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-actions').length===5`,'guide actions');
 for(const kind of ['agent','team']){
 await ev(`Array.from(document.querySelectorAll('#group-table-view .inbox-welcome-actions button')).find(b=>b.textContent==='New ${kind}').click();true`);
 const selector=kind==='agent'?'#launch-agent-acf .acf-prompt':'#team-goal';
 await waitFor(`!!document.getElementById('launch-step-${kind}') && document.getElementById('launch-step-${kind}').style.display !== 'none' && !!document.querySelector('${selector}')`,'guide form opens before reading its field');
 if(before)assert.equal(await ev(`document.querySelector('${selector}').value`),'');
 else assert.ok((await ev(`document.querySelector('${selector}').value`)).trim().length>20,`${width}: Inbox ${kind} guide supplies instructions`);
 if(!before){
 if(kind==='agent')assert.equal(await ev(`document.getElementById('launch-persona-select').value`),'Getting started','Inbox agent selects Getting started persona');
 if(kind==='agent')await waitFor(`!!document.querySelector('#launch-skills-host input[type=checkbox]:checked')`,'Getting started skill selected');
 else await waitFor(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].some(r=>/Orchestrator/.test(r.querySelector('.team-agent-role-name').textContent)&&!!r.dataset.skills)`,'Getting started skill is the Orchestrator\'s own (#18808), not every member\'s');
 }
 if(shots){
 await ev(kind==='agent'?`window._launchStage('persona');true`:`import((window.__coralStatic||'/static/')+'team_steps.js').then(m=>{m.showTeamStep('start');return true})`);
 await waitFor(`document.querySelector('${selector}').getClientRects().length>0`,'prompt visible in screenshot');
 const shot=await Page.captureScreenshot({format:'png'});fs.writeFileSync(path.join(shots,`${before?'before':'after'}-${kind}-${width}-${theme}.png`),Buffer.from(shot.data,'base64'));
 }
 await ev(`(()=>{const p=document.querySelector('${selector}');p.value='';p.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
 if(kind==='agent') assert.equal(await ev(`import((window.__coralStatic||'/static/')+'agent_config_form.js').then(m=>m.getAgentConfig('launch-agent-acf').prompt)`),'','clearing guide agent text stays empty in launch config');
 else assert.equal(await ev(`document.getElementById('team-goal').value`),'','clearing guide team text stays empty');
 if(!before){
 await ev(`(()=>{window.__guideLaunch=null;const set=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));};if('${kind}'==='agent')set('launch-dir','/work/payments-app');else{set('team-board-name','guide-test');set('launch-team-dir','/work/payments-app');}return true})()`);
 await ev(`Promise.resolve(window.${kind==='agent'?'launchSession':'launchTeam'}()).then(()=>true)`);
 await waitFor(`!!window.__guideLaunch`,'cleared prompt reaches intercepted launch request');
 const request=await ev(`window.__guideLaunch`);
 if(kind==='agent')assert.equal(request.body.skills?.length,1,'selected Getting started skill reaches launch request');
 else{assert.equal(request.body.skills,undefined,'no skill for every member (#18808)');const own=(request.body.agents||[]).filter(a=>a.skills&&a.skills.length);assert.equal(own.length,1,'only one member carries a skill: '+JSON.stringify(own.map(a=>a.name)));assert.match(own[0].name,/Orchestrator/,'and it is the Orchestrator');}
 if(kind==='agent')assert.equal(request.body.prompt||'','','cleared prompt is empty in real launch request');
 else assert.ok(!JSON.stringify(request.body).includes('getting-started-team'),'cleared team guide is absent from launch request');
 }
 await ev(`window.hideLaunchModal();true`);
 await ev(`document.querySelector('${kind==='agent'?'.sidebar-new-btn-full[data-on-click="launch-show"]':'.sidebar-new-btn-full[data-arg="team"]'}').click();true`);
 if(kind==='agent')await ev(`window._selectLaunchType('agent');true`);
 await waitFor(`!!document.querySelector('${selector}')`,'ordinary launch field');
 assert.equal(await ev(`document.querySelector('${selector}').value`),'',`${width}: ordinary ${kind} launch stays empty after the guide`);
 await ev(`window.hideLaunchModal();true`);
 }
 }
 console.log('PASS Inbox-only getting-started prefill and clear/ordinary-launch isolation');
}finally{await client.close()}})().catch(e=>{console.error(e);process.exitCode=1});
