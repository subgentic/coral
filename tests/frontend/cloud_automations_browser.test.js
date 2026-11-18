// #19571: the cloud Automations page reads one linked computer, never mutates,
// never reads the Hub's scheduler, and can navigate redacted jobs/workflows/runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const STUB = `(() => {
 const real = window.fetch, json = x => Promise.resolve(new Response(JSON.stringify(x), {headers:{'content-type':'application/json'}}));
 window.__automationReads=[]; window.__automationMutations=[]; window.__computers=[{id:'one',name:'First computer',status:'online'},{id:'two',name:'Second computer',status:'online'}];
 window.fetch=(u,o) => {
  const p=new URL(String(u && u.url || u),location.origin), path=p.pathname;
  if(o?.method && ['POST','PUT','PATCH','DELETE'].includes(o.method.toUpperCase())) window.__automationMutations.push({path,method:o.method,origin:p.origin,event:path==='/api/tracking/event' ? JSON.parse(o.body||'{}').event : ''});
  if(path==='/auth/session') return json({authenticated:true,email:'qa@example.com',csrf:'qa-csrf'});
  if(path==='/api/account') return json({});
  if(path==='/api/servers') return json({servers:window.__computers});
  if(path.includes('/api/scheduled') || path.includes('/api/workflows') || path.includes('/api/automations')) {
   window.__automationReads.push({path,method:o?.method || 'GET'});
   if(window.__automationDeny) return Promise.resolve(new Response('{}',{status:403}));
   const remote=path.startsWith('/api/remote/') ? path.split('/')[3] : ''; const api=remote ? path.slice(('/api/remote/'+remote).length) : path, who=remote || 'HUB';
   const run={id:9,kind:'job',job_name:who+' job',status:'completed',started_at:'2026-11-18T01:00:00Z',finished_at:'2026-11-18T01:01:00Z',duration_seconds:60};
   const job={id:1,name:who+' job <img src=x onerror=window.__pwn=1>',enabled:true,cron_expr:'0 * * * *',timezone:'UTC',last_run:run};
   const wf={id:2,name:who+' workflow',enabled:true,step_count:3,last_run:{...run,kind:'workflow'}};
   if(api==='/api/scheduled/jobs') return json({jobs:[job]});
   if(api==='/api/scheduled/jobs/1') return json(job);
   if(api==='/api/workflows') return json({workflows:[wf]});
   if(api==='/api/workflows/2') return json(wf);
   if(api==='/api/workflows/runs/9') return json({...run,kind:'workflow',workflow_name:who+' workflow'});
   if(api==='/api/automations/runs') return json({runs:[run,{...run,kind:'workflow',workflow_name:who+' workflow'}],total:2,has_more:false});
   if(api.endsWith('/runs')) return json({runs:[api.includes('workflows')?{...run,kind:'workflow'}:run],total:1,has_more:false});
   return json({runs:[]});
  }
  return real(u,o);
 };
})();`;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {Fetch,Network}=client;
 try {
  await Page.enable(); await Network.enable(); await Network.setBypassServiceWorker({bypass:true});
  await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD+'\n'+STUB});
  await Fetch.enable({patterns:[{urlPattern:'*',resourceType:'Document',requestStage:'Response'}]});
  safePaused(client,async e=>{
   if(e.responseStatusCode!==200)return Fetch.continueRequest({requestId:e.requestId});
   const {body,base64Encoded}=await Fetch.getResponseBody({requestId:e.requestId});
   const html=(base64Encoded?Buffer.from(body,'base64').toString('utf8'):body).replace(/"mode":\s*"local"/,'"mode":"cloud"');
   return Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:(e.responseHeaders||[]).filter(h=>!/^content-length$/i.test(h.name)),body:Buffer.from(html).toString('base64')});
  });
  await Emulation.setDeviceMetricsOverride({width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev,'startup','liveList','liveListLoaded','history','settings');
  assert.deepEqual(await ev('window.__automationReads'),[],'dashboard startup never reads or polls the scheduler in cloud');
  // Explicit inventory also isolates this from background server-status updates.
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers=window.__computers;state.hub=true;return true;})`);
  const route=async r=>{await ev(`import((window.__coralStatic||'/static/')+'nav.js').then(m=>m.go(${JSON.stringify(r)}))`);};
  const ready=async text=>waitFor(`document.querySelector('#scheduler-view')?.textContent.includes(${JSON.stringify(text)}) && !document.querySelector('#scheduler-view [aria-busy="true"]')`,text,10000);
  await route({view:'automations',folder:'jobs'}); await ready('one job');
  assert.deepEqual(await ev(`[...document.querySelector('#cloud-automation-computer').options].map(o=>o.value)`),['one','two'],'linked computers only, no local choice');
  assert.equal(await ev(`document.getElementById('nav-tab-automations').hasAttribute('data-local-only')`),false);
  await route({view:'automations',folder:'jobs',id:1}); await ready('Not shown through Coral Hub');
  await ev(`document.querySelector('[data-cloud-run]').click();true`); await ready('Run 9');
  await route({view:'automations',folder:'workflows'}); await ready('one workflow');
  await route({view:'automations',folder:'workflows',id:2}); await ready('3');
  await route({view:'automations',folder:'workflows',id:2,run:9}); await ready('Run 9');
  await route({view:'automations',folder:'recent'}); await ready('one job');
  await ev(`document.querySelector('#cloud-automation-computer').value='two';document.querySelector('#cloud-automation-computer').dispatchEvent(new Event('change',{bubbles:true}));true`); await ready('two job');
  assert.equal(await ev('window.__pwn'),undefined,'remote labels are text, not markup');
  assert.equal(await ev(`!!document.querySelector('#scheduler-view img')`),false);
  const controls=await ev(`[...document.querySelectorAll('#scheduler-view button')].filter(e=>e.getClientRects().length).map(e=>e.textContent.trim())`);
  assert.ok(controls.every(s=>! /^(New|Edit|Save|Duplicate|Delete|Run now|Run|Re-run|Stop|Build with agent|Edit with agent|Toggle)( |$)/i.test(s) || /^Run 9/.test(s)),JSON.stringify(controls));
  const calls=await ev('window.__automationReads');
  assert.ok(calls.length>5 && calls.every(r=>r.method==='GET' && /^\/api\/remote\/(one|two)\//.test(r.path)),JSON.stringify(calls));
  assert.ok(calls.every(r=>!r.path.endsWith('/seen')),'opening runs never marks them seen');
  // Existing dashboard startup telemetry is independent of Automations; every other mutation is forbidden.
  assert.deepEqual(await ev(`window.__automationMutations.filter(r=>r.path!=='/api/tracking/event')`),[],'the cloud visit sends no non-telemetry mutation request');
  if(process.env.CORAL_SCREENSHOT_DIR) {
   const dir=process.env.CORAL_SCREENSHOT_DIR; fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(dir+'/automations-desktop.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});
   await ev(`(async()=>{await ${framesJs(2)};return true;})()`);
   assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'phone page fits the screen');
   await waitFor(`!![...document.querySelectorAll('#scheduler-view button')].find(e=>e.textContent.includes('two job') && e.getClientRects().length)`,'visible phone run rows',5000).catch(async e=>{fs.writeFileSync(dir+'/phone-diagnostic.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));console.error(await ev(`({body:document.body.className,nav:document.body.dataset.navTab,view:getComputedStyle(document.getElementById('scheduler-view')).display,detail:getComputedStyle(document.getElementById('scheduler-detail')).display,cls:document.getElementById('scheduler-detail').className,buttons:[...document.querySelectorAll('#scheduler-view button')].map(e=>({text:e.textContent,rect:e.getClientRects().length,display:getComputedStyle(e).display})),html:document.getElementById('scheduler-detail').innerHTML.slice(0,3000),ancestors:[...(()=>{let e=document.getElementById('scheduler-detail'),a=[];while(e){a.push(e);e=e.parentElement;}return a;})()].map(e=>({tag:e.id||e.tagName,display:getComputedStyle(e).display,rect:e.getClientRects().length})),css:[...document.styleSheets].map(s=>s.href).filter(x=>x?.includes('automations_cloud'))})`));throw e;});
   assert.equal(await ev(`!!document.querySelector('#phone-fab')?.getClientRects().length`),false,'cloud Automations has no phone New button');
   fs.writeFileSync(dir+'/automations-phone.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
  }
  await ev('window.__automationDeny=true;true'); await route({view:'automations',folder:'jobs'}); await ready('Could not read');
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers=[];window.__automationReads=[];return true;})`);
  await route({view:'automations',folder:'workflows'}); await ready('Link a computer');
  assert.deepEqual(await ev('window.__automationReads'),[],'no linked computer sends no request');
  console.log('Cloud startup telemetry (same-origin, not a computer):', await ev(`window.__automationMutations.filter(r=>r.path==='/api/tracking/event')`));
  console.log('PASS cloud Automations: linked-computer GETs only, read-only jobs/workflows/runs, no scheduler startup read, redaction and no-computer/error states');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
