// #18119: only the two Inbox guide entry points prefill; ordinary launches stay blank.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const {install:installTeam,stubModels}=require('./helpers/new_team');
const BASE=require('./test_base').BASE;
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();try{
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
 for(const width of [1280,390]){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await installTeam(ev);await stubModels(ev);
 await ev(`(()=>{const real=window.fetch;window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(p==='/api/board/projects')return Promise.resolve(Response.json([]));if(p==='/api/settings'&&o.method==='PUT')return Promise.resolve(Response.json({ok:true}));return real(u,o)};window.T.state.settings={...window.T.state.settings,inbox_welcome:'on',inbox_welcome_done:''};window.T.state.liveSessions=[];window.T.state.servers=[];window.switchNavTab('hub-inbox');return true})()`);
 await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>{m.updateInboxTab();return m.selectInboxTab('needs')}).then(()=>true)`);
 await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-actions').length===6`,'guide actions');
 for(const kind of ['agent','team']){
 await ev(`Array.from(document.querySelectorAll('#group-table-view .inbox-welcome-actions button')).find(b=>b.textContent==='New ${kind}').click();true`);
 const selector=kind==='agent'?'#launch-agent-acf .acf-prompt':'#team-goal';
 await waitFor(`!!document.querySelector('${selector}')`,'prompt field');
 assert.ok((await ev(`document.querySelector('${selector}').value`)).trim().length>20,`${width}: Inbox ${kind} guide supplies instructions`);
 await ev(`(()=>{const p=document.querySelector('${selector}');p.value='';p.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
 if(kind==='agent') assert.equal(await ev(`import((window.__coralStatic||'/static/')+'agent_config_form.js').then(m=>m.getAgentConfig('launch-agent-acf').prompt)`),'','clearing guide agent text stays empty in launch config');
 else assert.equal(await ev(`document.getElementById('team-goal').value`),'','clearing guide team text stays empty');
 await ev(`window.hideLaunchModal();true`);
 await ev(`(async()=>{await window.showLaunchModal();window._selectLaunchType('${kind}');return true})()`);
 await waitFor(`!!document.querySelector('${selector}')`,'ordinary launch field');
 assert.equal(await ev(`document.querySelector('${selector}').value`),'',`${width}: ordinary ${kind} launch stays empty after the guide`);
 await ev(`window.hideLaunchModal();true`);
 }
 }
 console.log('PASS Inbox-only getting-started prefill and clear/ordinary-launch isolation');
}finally{await client.close()}})().catch(e=>{console.error(e);process.exitCode=1});
