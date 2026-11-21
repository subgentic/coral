// #20207: the computer bar, its sorted list with the divider, and the plain cards for a computer that cannot be read (mock #20178).
// With CORAL_SCREENSHOT_DIR it also writes the shots the side-by-side page is made from (light and dark, 1280 and 390).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const SHOT=process.env.CORAL_SCREENSHOT_DIR;
const STUB = `(() => {
 const real = window.fetch, json = x => Promise.resolve(new Response(JSON.stringify(x), {headers:{'content-type':'application/json'}}));
 window.__automationReads=[]; window.__automationMutations=[]; window.__computers=[{id:'old-laptop',name:'old-laptop',status:'offline',last_seen:'2026-11-20T18:40:00Z'},{id:'frontier',name:'frontier',status:'online',coral_version:'2.1.1',access_mode:'launch'},{id:'lab-pc',name:'lab-pc',status:'online',coral_version:'2.0.4',below_minimum:true,min_coral:'2.1.0',access_mode:'interact'},{id:'studio-mac',name:'studio-mac',status:'online',coral_version:'2.1.1+abc123.dirty',access_mode:'interact'}];
 window.fetch=(u,o) => {
  const p=new URL(String(u && u.url || u),location.origin), path=p.pathname;
  if(o?.method && ['POST','PUT','PATCH','DELETE'].includes(o.method.toUpperCase())) window.__automationMutations.push({path,method:o.method,origin:p.origin,event:path==='/api/tracking/event' ? JSON.parse(o.body||'{}').event : ''});
  if(path==='/auth/session') return json({authenticated:true,email:'qa@example.com',csrf:'qa-csrf'});
  if(path==='/api/account') return json({});
  if(path==='/api/servers') return json({servers:window.__computers});
  if(path.includes('/api/scheduled') || path.includes('/api/workflows') || path.includes('/api/automations')) {
   window.__automationReads.push({path,method:o?.method || 'GET'});
   const who0=path.startsWith('/api/remote/')?path.split('/')[3]:''; if(window.__deny&&window.__deny[who0]) return Promise.resolve(new Response(window.__denyBody?JSON.stringify(window.__denyBody):'{}',{status:window.__deny[who0]}));
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
const setTheme=(ev,theme)=>ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'settings_core.js');m.clearCustomThemeVars();m.applyTheme(${JSON.stringify(theme)});await ${framesJs(2)};return true;})()`);
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
  const shot=async name=>{ if(!SHOT) return; fs.mkdirSync(SHOT,{recursive:true}); fs.writeFileSync(SHOT+'/'+name+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
  const route=async r=>{await ev(`import((window.__coralStatic||'/static/')+'nav.js').then(m=>m.go(${JSON.stringify(r)}))`);};
  const ready=text=>waitFor(`document.querySelector('#scheduler-view')?.textContent.includes(${JSON.stringify(text)}) && !document.querySelector('#scheduler-view [aria-busy="true"]')`,text,10000);
  const pick=id=>ev(`(()=>{const r=document.getElementById('cloud-automation-computer');r.querySelector('.computer-bar-button').click();r.querySelector('.computer-bar-option[data-computer=${JSON.stringify(id)}]').click();return true;})()`);
  await Emulation.setDeviceMetricsOverride({width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev,'startup','liveList','liveListLoaded','history','settings');
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers=window.__computers;state.hub=true;return true;})`);
  for (const [w,h,mobile] of [[1280,800,false],[390,844,true]]) {
   await Emulation.setDeviceMetricsOverride({width:w,height:h,deviceScaleFactor:1,mobile});
   for (const theme of ['light','dark']) {
    await setTheme(ev,theme);
    const tag=`${theme}-${w}`;
    await ev(`window.__deny={};import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{delete state.machineChosen;state.servers.find(s=>s.id==='old-laptop').status='offline';return true;})`);
    await route({view:'automations',folder:'jobs'}); await ready('frontier job');
    await shot(`${tag}-bar-closed`);
    // the open list: the divider sits between the online and the offline computers; the phone gets a sheet
    await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button').click();true`);
    const open=await ev(`(()=>{const l=document.querySelector('#cloud-automation-computer .computer-bar-list'),b=document.querySelector('#cloud-automation-computer .computer-bar-button').getBoundingClientRect(),r=l.getBoundingClientRect(),cs=getComputedStyle(l);return {hidden:l.hidden,pos:cs.position,w:Math.round(r.width),bottom:Math.round(innerHeight-r.bottom),btnH:Math.round(b.height),btnW:Math.round(b.width),order:[...l.children].map(n=>n.dataset.computer||n.className.replace('computer-bar-',''))};})()`);
    assert.equal(open.hidden,false,'the list opens');
    assert.deepEqual(open.order,['all','group','frontier','lab-pc','studio-mac','divider','group','old-laptop'].map(x=>x==='all'?'all':x),'All computers, the online computers, the divider, then the offline ones');
    if(mobile){ assert.equal(open.pos,'fixed','on a phone the list is a sheet'); assert.equal(open.bottom,0,'the sheet sits at the bottom'); assert.ok(open.btnH>=44,'the bar is 44 px tall'); assert.ok(open.btnW>=300,'the bar is full width'); }
    else { assert.equal(open.pos,'absolute'); assert.ok(open.w<=384,'the list is no wider than 24rem'); }
    // the list's second line (#20319, the mock): version and Hub access for an online computer, what an update shows for an old one, 'Offline since <time>' for an offline one; the old one has the amber dot and the chip
    const subs=await ev(`Object.fromEntries([...document.querySelectorAll('#cloud-automation-computer .computer-bar-option')].map(o=>[o.dataset.computer,{sub:o.querySelector('.computer-bar-sub').textContent,chip:o.querySelector('.computer-chip')?.textContent||'',dot:o.querySelector('.computer-dot')?.getAttribute('data-computer-state')||''}]))`);
    assert.equal(subs.frontier.sub,'Coral 2.1.1 · Hub access: Launch'); assert.equal(subs['studio-mac'].sub,'Coral 2.1.1 · Hub access: Interact','a build suffix is cut from the version');
    assert.deepEqual(subs['lab-pc'],{sub:'Coral 2.0.4 · update to see automations',chip:'Update needed',dot:'update'},'an old computer: amber dot, the chip and what an update shows');
    assert.match(subs['old-laptop'].sub,/^Offline since (today at \d\d:\d\d|yesterday at \d\d:\d\d|\d{1,2} [A-Z][a-z]{2})$/,'an offline computer says since when, in the card\'s words');
    await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{const f=state.servers.find(s=>s.id==='frontier');window.__fkeep={v:f.coral_version,a:f.access_mode};delete f.coral_version;delete f.access_mode;return true;})`);
    await route({view:'automations',folder:'jobs'}); await ready('frontier job'); await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button').click();true`);
    assert.equal(await ev(`document.querySelector('#cloud-automation-computer .computer-bar-option[data-computer=frontier] .computer-bar-sub').textContent`),'Online','a version or access the Hub list does not carry is left out, not guessed');
    await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{const f=state.servers.find(s=>s.id==='frontier');f.coral_version=window.__fkeep.v;f.access_mode=window.__fkeep.a;return true;})`);
    await route({view:'automations',folder:'jobs'}); await ready('frontier job'); await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button').click();true`);
    await shot(`${tag}-bar-open`);
    await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button').click();true`);
    // one card per cannot state, each naming the computer, none showing an HTTP code in its headline
    await pick('old-laptop'); await ready('old-laptop is offline');
    assert.match(await ev(`document.querySelector('[data-computer-card=offline]').textContent`),/It was last connected (today at \d\d:\d\d|yesterday at \d\d:\d\d|\d{1,2} [A-Z][a-z]{2})\./,'the offline card says when it last connected, in the mock\'s words');
    { const words=(await ev(`document.querySelector('[data-computer-card=offline]').textContent`)).match(/last connected ([^.]+)\./)[1]; assert.equal(subs['old-laptop'].sub,`Offline since ${words}`,'the list says the time as the card does'); }
    assert.equal(await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button .computer-dot').getBoundingClientRect().width`),8,'the bar shows the computer\'s dot');
    assert.equal(await ev(`document.querySelector('#cloud-automation-computer .computer-bar-button .computer-chip').textContent`),'Offline','and the one-word chip when it is off');
    await shot(`${tag}-card-offline`);
    await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers.find(s=>s.id==='old-laptop').status='online';return true;})`);
    for (const [id,status,text,name,body] of [['lab-pc',404,"lab-pc can't show automations here",'old'],['studio-mac',403,'studio-mac does not share its automations with the Hub','not-shared'],['frontier',500,'frontier did not answer','no-answer'],['lab-pc',409,'lab-pc needs an update to share its automations','update-required',{error:'coral_too_old',min:'2.1.0'}]]) {
     await ev(`window.__denyBody=${JSON.stringify(body||null)};window.__deny={${JSON.stringify(id)}:${status}};true`);
     await pick(id); await ready(text);
     assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card').dataset.computerCard`),name);
     await shot(`${tag}-card-${name}`);
     if(name==='update-required'){
      const card=await ev(`({title:document.querySelector('#scheduler-view .computer-card-title').textContent,why:document.querySelector('#scheduler-view .computer-card-why').textContent,buttons:[...document.querySelectorAll('#scheduler-view .computer-card button')].map(b=>b.textContent)})`);
      assert.equal(card.title,'lab-pc needs an update to share its automations'); assert.equal(card.why,'It runs Coral 2.0.4. The Hub can read automations from Coral 2.1.0 on. Everything else about lab-pc still works.','the mock\'s sentence, with the version the Hub list carries');
      assert.deepEqual(card.buttons,['Show how to update','Switch computer','Open Computers'],'the mock\'s three buttons');
      assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-steps').hidden`),true,'the steps wait behind Show how to update');
      await ev(`[...document.querySelectorAll('#scheduler-view .computer-card button')].find(b=>b.textContent==='Show how to update').click();true`);
      assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-steps a').href`),'https://coralhub.dev/coral.html#download','the one download page');
      assert.ok(await ev(`/Details for support/.test(document.querySelector('#scheduler-view .computer-card').textContent)`),'the raw code stays folded away');
      // without the version the Hub list carries, the card writes no 'It runs Coral' line
      await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{const e=state.servers.find(s=>s.id==='lab-pc');window.__vkeep=e.coral_version;delete e.coral_version;return true;})`);
      await route({view:'automations',folder:'jobs'}); await pick('lab-pc'); await ready('lab-pc needs an update to share its automations');
      assert.equal(await ev(`document.querySelector('#scheduler-view .computer-card-why').textContent`),'The Hub can read automations from Coral 2.1.0 on. Everything else about lab-pc still works.','no version in the Hub list: no line about it');
      await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers.find(s=>s.id==='lab-pc').coral_version=window.__vkeep;return true;})`);
     }
     await ev(`window.__deny={};true`);
    }
    assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'the page fits the screen');
   }
  }
  console.log('PASS computer bar: sorted list with the divider, phone sheet, one card per cannot state');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
