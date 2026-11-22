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
 window.__automationReads=[]; window.__automationMutations=[]; window.__computers=[{id:'three',name:'Third computer',status:'offline',last_seen:'2026-11-18T10:00:00Z'},{id:'one',name:'First computer',status:'online'},{id:'four',name:'Fourth computer',status:'offline',last_seen:'2026-11-20T10:00:00Z'},{id:'two',name:'Second computer',status:'online'}];
 window.fetch=(u,o) => {
  const p=new URL(String(u && u.url || u),location.origin), path=p.pathname;
  if(o?.method && ['POST','PUT','PATCH','DELETE'].includes(o.method.toUpperCase())) window.__automationMutations.push({path,method:o.method,origin:p.origin,event:path==='/api/tracking/event' ? JSON.parse(o.body||'{}').event : ''});
  if(path==='/auth/session') return json({authenticated:true,email:'qa@example.com',csrf:'qa-csrf'});
  if(path==='/api/account') return json({});
  if(path==='/api/servers') return json({servers:window.__computers});
  if(path.includes('/api/scheduled') || path.includes('/api/workflows') || path.includes('/api/automations')) {
   window.__automationReads.push({path,method:o?.method || 'GET'});
   if(window.__automationDeny && (!window.__automationDenyServer || path.startsWith('/api/remote/'+window.__automationDenyServer+'/')) && (!window.__automationDenyPath || path.endsWith(window.__automationDenyPath))) return Promise.resolve(new Response(JSON.stringify(window.__automationErrorBody || {}),{status:window.__automationDeny}));
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
  assert.deepEqual(await ev(`[...document.querySelectorAll('#cloud-automation-computer .computer-bar-option')].map(o=>o.dataset.computer)`),['all','one','two','four','three'],'All computers first, then linked computers only, no local choice; online first, then offline, most recently seen first inside each group (#20207)');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#cloud-automation-computer .computer-bar-list > *')].map(n=>n.className.replace('computer-bar-','')+(n.dataset.computer?':'+n.dataset.computer:''))`),['option:all','group','option:one','option:two','divider','group','option:four','option:three'],'a divider bar sits between the online and the offline computers');
  assert.equal(await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button').textContent.trim()`),'All computers','with two or more computers the bar opens on All computers (the default, like Agents and the Inbox)');
  assert.equal(await ev(`getComputedStyle(document.querySelector('#cloud-automation-computer')).display`),'flex');
  assert.equal(await ev(`document.querySelector('#scheduler-view').textContent.includes('Read only here. Edit them in Coral on each computer.')`),true,'the read-only fact is one quiet line beside the bar, with its next step');
  assert.equal(await ev(`document.getElementById('nav-tab-automations').hasAttribute('data-local-only')`),false);
  assert.ok(await ev(`document.querySelector('#scheduler-view').textContent.includes('two job')`),'All computers merges the rows of every readable computer');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-view [role=columnheader], #scheduler-view .dt-head [data-col], #scheduler-view th')].map(e=>e.textContent.trim()).filter(Boolean)`),['Job','Computer','Schedule','State'],'the mock\'s columns: Job, Computer, Schedule, State (last run lives in the details)');
  assert.equal(await ev(`document.querySelector('#scheduler-view .computer-not-shown p').textContent`),'Not shown: Fourth computer is offline · Third computer is offline.','unreadable computers are named once under the list');
  assert.equal(await ev(`document.querySelector('.cloud-automation-count').textContent`),'4 computers · 2 of them cannot be read');
  await route({view:'automations',folder:'jobs',id:1}); await ready('Not shown through Coral Hub');
  await ev(`document.querySelector('[data-cloud-run]').click();true`); await ready('Run 9');
  await route({view:'automations',folder:'workflows'}); await ready('one workflow');
  await route({view:'automations',folder:'workflows',id:2}); await ready('3');
  await route({view:'automations',folder:'workflows',id:2,run:9}); await ready('Run 9');
  await route({view:'automations',folder:'recent'}); await ready('one job');
  await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button').click();document.querySelector('#cloud-automation-computer .computer-bar-option[data-computer="two"]').click();true`); await ready('two job');
  assert.equal(await ev(`document.querySelector('#cloud-automation-computer .computer-bar-list').hidden`),true,'picking closes the list');
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
  const CARDS = { 403: ['not-shared', 'Second computer does not share its automations with the Hub', 'Open Computers'], 404: ['old', "Second computer can't show automations here", 'Retry'], 500: ['no-answer', 'Second computer did not answer', 'Try again'] };
  for (const status of [403, 404, 500]) {
   const [kind, headline, button] = CARDS[status];
   await ev(`window.__automationDeny=${status};true`); await route({view:'automations',folder:'jobs'});
   await ready(headline);
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card')?.dataset.computerCard`), kind, `${status} is the ${kind} card`);
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-title').textContent`), headline);
   assert.equal(await ev(`!!document.querySelector('#scheduler-view .notice-error') || /HTTP \\d{3}/.test(document.querySelector('#scheduler-view .computer-card').textContent.replace(/Details for support[\\s\\S]*/, ''))`), false, 'the headline and sentence never print an HTTP code or a red error');
   assert.ok((await ev(`document.querySelector('#scheduler-view .computer-card-details').textContent`)).includes(String(status)), 'the raw code is folded into Details for support');
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-details').open`), false, 'Details for support is closed');
   assert.ok(await ev(`!![...document.querySelectorAll('#scheduler-view .computer-card button')].find(b=>b.textContent===${JSON.stringify(button)})`), `${kind} offers ${button}`);
   assert.ok(await ev(`!![...document.querySelectorAll('#scheduler-view .computer-card button')].find(b=>b.textContent==='Switch computer')`), 'the card offers Switch computer');
  }
  // #20185: only the Hub's explicit owner-only 409 contract proves an update is required.
  for (const width of [1280,390]) for (const theme of ['light','dark']) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'settings_core.js');m.clearCustomThemeVars();m.applyTheme('${theme}');window.__automationDeny=409;window.__automationErrorBody={error:'coral_too_old',min:'9.7.3'};return true;})()`);
   await route({view:'automations',folder:'jobs'});
   await waitFor(`!!document.querySelector('#scheduler-view .computer-card') && !document.querySelector('#scheduler-view [aria-busy="true"]')`, 'the computer refusal card',10000);
   assert.ok(await ev(`document.querySelector('#scheduler-view .computer-card-details').textContent.includes('409')`),'the current refusal is 409');
   if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});await ev(framesJs(2));fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/update-required-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-title').textContent`),'Second computer needs an update to share its automations','name comes from the selected computer');
   assert.ok((await ev(`document.querySelector('#scheduler-view .computer-card-why').textContent`)).includes('The Hub can read automations from Coral 9.7.3 on. Everything else about Second computer still works.'),'the minimum comes from the Hub body, in the mock\'s sentence');
   assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-view .computer-card button')].map(b=>b.textContent)`),['Show how to update','Switch computer','Open Computers'],'the mock\'s three buttons');
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card').dataset.computerCard`),'update-required');
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-details').open`),false,'support details stay collapsed');
   assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'the update card fits the phone or desktop');
  }
  const refused = [
   ...['please update','1.2','v1.2.3','1.2.3 please update',' 1.2.3','1.2.3\n','12345678901234567.1.1'].map(min=>[409,{error:'coral_too_old',min},'no-answer']),
   [409,{},'no-answer'],[409,{error:'coral_too_old'},'no-answer'],[409,{error:'coral_too_old',min:0},'no-answer'],
   [409,{error:'coral_too_old',min:''},'no-answer'],[409,{error:'coral_too_old',min:'  '},'no-answer'],[409,{error:'coral_too_old',min:'9.7.3',extra:true},'no-answer'],[409,{error:'other',min:'9.7.3'},'no-answer'],
   [403,{error:'coral_too_old',min:'9.7.3'},'not-shared'],[404,{error:'coral_too_old',min:'9.7.3'},'old'],[500,{error:'coral_too_old',min:'9.7.3'},'no-answer']
  ];
  for(const [status,body,kind] of refused){
   await ev(`window.__automationDeny=${status};window.__automationErrorBody=${JSON.stringify(body)};true`);
   await route({view:'automations',folder:'jobs'});
   await waitFor(`!!document.querySelector('#scheduler-view .computer-card') && !document.querySelector('#scheduler-view [aria-busy="true"]')`, 'fallback refusal card',10000);
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card').dataset.computerCard`),kind,'other statuses and malformed bodies preserve the existing card');
   assert.ok(!(await ev(`document.querySelector('#scheduler-view .computer-card-title').textContent`)).includes('needs an update'),'a grantee/stranger refusal or unknown failure never claims an update is known');
  }
  for(const min of ['0.0.0','1234567890123456.1.1']){
   await ev(`window.__automationDeny=409;window.__automationErrorBody={error:'coral_too_old',min:${JSON.stringify(min)}};true`);
   await route({view:'automations',folder:'jobs'}); await ready('needs an update to share its automations');
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-title').textContent`),'Second computer needs an update to share its automations','an update card for a valid floor');
   assert.ok((await ev(`document.querySelector('#scheduler-view .computer-card-why').textContent`)).includes(`from Coral ${min} on.`),'valid floors including the 20-character boundary are retained');
  }
  const unsafeName='<img src=x onerror="window.__updatePwn=1">', unsafeMin='<svg onload="window.__updatePwn=2">';
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers.find(s=>s.id==='two').label=${JSON.stringify(unsafeName)};window.__automationDeny=409;window.__automationErrorBody={error:'coral_too_old',min:${JSON.stringify(unsafeMin)}};return true;})`);
  await route({view:'automations',folder:'jobs'}); await ready('did not answer');
  assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card').dataset.computerCard`),'no-answer','markup-like minimum versions use the existing fallback card');
  assert.ok((await ev(`document.querySelector('#scheduler-view .computer-card-title').textContent`)).includes(unsafeName),'computer names remain literal text even on fallback cards');
  assert.equal(await ev(`!!window.__updatePwn || !!document.querySelector('#scheduler-view .computer-card img, #scheduler-view .computer-card svg')`),false,'response and computer labels never become markup');
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{delete state.servers.find(s=>s.id==='two').label;window.__automationDeny=409;window.__automationErrorBody={error:'coral_too_old',min:'8.6.4'};window.__automationDenyServer='two';state.machineChosen='all';return true;})`);
  await route({view:'automations',folder:'jobs'}); await ready('one job');
  assert.deepEqual(await ev(`document.querySelector('.computer-not-shown > p').textContent.replace(/^Not shown: /,'').replace(/\\.$/,'').split(' · ').sort()`),['Fourth computer is offline','Third computer is offline','Update Coral on Second computer to 8.6.4 to see this'],'All computers names every unreadable computer and the required version beside readable rows');
  assert.ok(await ev(`document.querySelector('.cloud-automation-content table').textContent.includes('one job')`),'the readable computer keeps its automation rows');
  assert.equal(await ev(`document.querySelector('.cloud-automation-content table').textContent.includes('two job')`),false,'the unreadable computer contributes no rows');
  await ev(`import((window.__coralStatic||'/static/')+'analytics_machine.js').then(m=>{m.pickMachine('two');window.__automationDenyPath='/api/scheduled/jobs/1/runs';return true;})`);
  await route({view:'automations',folder:'jobs',id:1}); await ready('Second computer needs an update to share its automations');
  assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-title').textContent`),'Second computer needs an update to share its automations','a nested run-history read keeps the update card too');
  await ev(`window.__automationDeny=0;delete window.__automationErrorBody;delete window.__automationDenyPath;delete window.__automationDenyServer;true`);
  await ev('window.__automationDeny=0;true');
  await ev(`window.__automationDeny=0;true`); await route({view:'automations',folder:'jobs'}); await ready('two job');
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers.find(s=>s.id==='two').status='offline';window.__automationReads=[];return true;})`);
  for (const request of [{folder:'jobs'}, {folder:'workflows'}, {folder:'recent'}, {folder:'running'}, {folder:'failed'}, {folder:'jobs',id:1}, {folder:'workflows',id:2,run:9}]) {
   await route({view:'automations',...request}); await ready("Second computer is offline");
   assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card')?.dataset.computerCard`),'offline');
  }
  assert.deepEqual(await ev('window.__automationReads'),[],'an offline computer sends no list, detail, or run read');
  assert.equal(await ev(`document.querySelector('#cloud-automation-computer .computer-chip').textContent`),'Offline','an offline computer shows the one-word chip on the bar');
  assert.equal(await ev(`!!document.querySelector('#cloud-automation-computer .computer-bar-option[data-computer="two"]')`),true,'offline computers remain named and pickable in the list');
  await ev(`[...document.querySelectorAll('#scheduler-view button')].find(b=>b.textContent==='Try again').click();true`);
  await ready("Second computer is offline");
  assert.deepEqual(await ev('window.__automationReads'),[],'Retry while offline sends no read');
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers.find(s=>s.id==='two').status='online';return true;})`);
  await ev(`[...document.querySelectorAll('#scheduler-view button')].find(b=>b.textContent==='Try again').click();true`); await ready('Run 9');
  assert.ok((await ev('window.__automationReads')).length>0,'Retry after reconnect reads the selected computer');
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers=[];window.__automationReads=[];return true;})`);
  await route({view:'automations',folder:'workflows'}); await ready('Link a computer');
  assert.deepEqual(await ev('window.__automationReads'),[],'no linked computer sends no request');
  console.log('Cloud startup telemetry (same-origin, not a computer):', await ev(`window.__automationMutations.filter(r=>r.path==='/api/tracking/event')`));
  console.log('PASS cloud Automations: linked-computer GETs only, read-only jobs/workflows/runs, no scheduler startup read, redaction and no-computer/error states');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
