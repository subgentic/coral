// #22094/v19 retires main-list star/pin geometry and inline actions; see needs_ledger_retired_checks.md.
// Retain source-qualified goal groups, producer overflow, versions/opened writes, unchanged agent-tab star owner, sent-back state and viewport coverage.
// #13888/#13889: real Needs you table, grouping, source identity and accessible pin control.
const assert=require('node:assert/strict');const fs=require('node:fs');
const {connect}=require('./agent_view_harness');const {coralReady,framesJs}=require('./helpers/wait');
const {setupHubWorld}=require('./helpers/hub_world');
const {removeBoards}=require('./helpers/board_cleanup');const BASE=require('./test_base').BASE;
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const team='goal-groups-'+Date.now().toString(36);
try{await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Page.addScriptToEvaluateOnNewDocument({source:"localStorage.removeItem('coral-inbox-group-review-goal');localStorage.removeItem('coral-inbox-group-mode');localStorage.removeItem('coral-inbox-needs-tab');"});
for(const [width,theme] of [[1280,'light'],[390,'light'],[320,'light'],[1280,'dark'],[390,'dark'],[320,'dark']]){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width<=760});await Emulation.setTouchEmulationEnabled({enabled:width<=760});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});true`);
 await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Dev',job_title:'Developer'})}).then(r=>r.status)`);
 await ev(`(()=>{localStorage.removeItem('coral-inbox-group-review-goal');localStorage.removeItem('coral-inbox-group-mode');const original=window.fetch.bind(window),json=b=>Promise.resolve(Response.json(b)),hex=n=>n.toString(16).padStart(64,'0');window.__groupCalls=[];window.__groupRows=Array.from({length:13},(_,i)=>({id:hex(i+1),name:'Document '+(i+1)+'.md',uri:'coral://artifacts/'+hex(i+1),produced_by:'Developer',session_id:'same-producer',created_at:new Date(Date.now()-i*60000).toISOString(),media_type:'text/markdown',available:true,tags:['for review'],goal_id:i<2?1:i===2?2:null,goal_title:i<2?'Update reliability':i===2?'Accessibility':'',starred:i===12,series_id:'series-'+i,version:i===2?3:1,opened_version:i===2?1:undefined}));window.__openedCalls=[];for(const n of [14,15])window.__groupRows.push({id:hex(n),name:'Waiting '+n+'.md',uri:'coral://artifacts/'+hex(n),produced_by:'Waiting agent '+n,session_id:'waiting-'+n,series_id:'waiting-series-'+n,created_at:new Date(Date.now()-n*60000).toISOString(),media_type:'text/markdown',available:true,tags:['for review','changes requested'],new_comments:n===15?2:0});window.fetch=(url,opts={})=>{const u=new URL(String(url),location.href);if(u.pathname==='/api/team-artifacts')return json(window.__reviewFixturePage(u,location.href,{'${team}':window.__groupRows}));if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.endsWith('/star')){window.__groupCalls.push({path:u.pathname,method:opts.method});const a=window.__groupRows.find(a=>u.pathname.includes(a.id));a.starred=opts.method==='PUT';return json({starred:a.starred});}if(u.pathname==='/api/board/${team}/artifacts')return json({artifacts:window.__groupRows,has_more:false});if(u.pathname.startsWith('/api/board/${team}/artifacts/')&&u.pathname.endsWith('/tags')){const a=window.__groupRows.find(a=>u.pathname.includes(a.id));a.tags=JSON.parse(opts.body).tags;return json({tags:a.tags});}if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.endsWith('/opened')){const a=window.__groupRows.find(a=>u.pathname.includes(a.id));window.__openedCalls.push(u.pathname);a.opened_version=a.version;return json({series_id:a.series_id,opened_version:a.version});}if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.split('/').length===4)return Promise.resolve(new Response('# Loaded document',{headers:{'Content-Type':'text/markdown'}}));return original(url,opts);};return true;})()`);
 await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
 await waitFor(`document.querySelectorAll('.nl-file').length===12`,'ten producer files, its starred file and the replied file are loaded');
 const headings=await ev(`[...document.querySelectorAll('.nl-group-head .nl-title')].map(n=>n.textContent)`);
 assert.ok(headings.some(t=>/#1.*Update reliability/.test(t))&&headings.some(t=>/#2.*Accessibility/.test(t))&&headings.includes('Not tied to a goal'),JSON.stringify(headings));
 assert.ok(await ev(`[...document.querySelectorAll('.nl-group-body')].every(n=>n.hidden)`),'review-only groups start folded');
 await ev(`document.querySelector('.inbox-fold-all').click();true`);
 assert.ok(await ev(`[...document.querySelectorAll('.nl-group-body')].every(n=>!n.hidden)`),'fold-all reveals every review group');
 const rows=await ev(`[...document.querySelectorAll('.nl-file')].map(r=>({name:r.querySelector('.nl-file-open').textContent,accessible:r.getAttribute('aria-label'),opener:r.querySelector('.nl-file-open').tagName,hasInlineDecisions:!!r.querySelector('.inbox-review-actions,.inbox-review-star')}))`);
 for(const i of [...Array.from({length:10},(_,i)=>i+1),13])assert.ok(rows.some(r=>r.name.includes('Document '+i+'.md')),'producer group retains document '+i);
 assert.ok(await ev(`(() => { const p=document.querySelector('.inbox-review-more');return p && /2 more for review/.test(p.textContent) && !!p.querySelector('a,button'); })()`),'producer overflow keeps the two remaining files reachable in team artifacts');
 assert.ok(rows.every(r=>r.opener==='BUTTON'&&r.accessible&&!r.hasInlineDecisions),'each file keeps a named opener; inline star/decision placement retired under v19');
 const versionId='3'.padStart(64,'0');
 await ev(`[...document.querySelectorAll('.nl-file-open')].find(b=>b.textContent.includes('Document 3.md')).click();true`);
 await waitFor(`window.__openedCalls.length===1`,'successfully opened version is recorded once');
 await ev(`document.querySelector('.artifact-viewer-close').click();true`);
 try { await waitFor(`![...document.querySelectorAll('.nl-file')].find(r=>r.textContent.includes('Document 3.md')).querySelector('.nl-new')`,'new-version attention clears after opening'); } catch(e) { throw new Error(e.message+' '+await ev(`JSON.stringify({fixture:window.__groupRows.find(r=>r.name==='Document 3.md'),row:[...document.querySelectorAll('.nl-file')].find(r=>r.textContent.includes('Document 3.md'))?.textContent,live:document.querySelector('.inbox-live')?.textContent,toasts:[...document.querySelectorAll('.toast')].map(n=>n.textContent)})`)); }
 await ev(`document.querySelector('[data-needs-tab="agent"]').click();true`);
 const waitingId='e'.padStart(64,'0');
 await waitFor(`!!document.querySelector('[data-review-artifact="${waitingId}"]')`,'the sent-back file is on Waiting on an agent');
 assert.equal(await ev(`document.querySelector('[data-review-artifact="${waitingId}"]').closest('tr').classList.contains('dt-read')`),true,'sent-back without news stays visible and uncounted');
 await ev(`document.querySelector('[data-review-artifact="${waitingId}"]').closest('tr').querySelector('.inbox-review-star').click();true`);
 await waitFor(`window.__groupCalls.length===1`,'the unchanged agent tab still stars through its owner');
 assert.equal(await ev(`window.__groupCalls[0].method`),'PUT');
 await ev(`document.querySelector('[data-needs-tab="you"]').click();true`);
 await waitFor(`!!document.querySelector('.needs-ledger')`,'back to the ledger');
 assert.ok(await ev(`![...document.querySelectorAll('.nl-file')].some(r=>r.textContent.includes('Waiting 14.md'))`),'sent-back without news stays out of Waiting on you');
 assert.equal(await ev(`document.documentElement.scrollWidth>innerWidth+1`),false,'no horizontal overflow at '+width);
 if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/goal-groups-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
}
await setupHubWorld({client,Page,Emulation,width:1280,height:900,mobile:false,inbox:'native',needs:true,hubPages:true});
for(const width of [1280,390,320]){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width<=760});await Emulation.setTouchEmulationEnabled({enabled:width<=760});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');
 await ev(`(()=>{const original=window.fetch.bind(window),json=b=>Promise.resolve(Response.json(b));window.__remoteStars=[];window.fetch=(url,opts={})=>{const u=new URL(String(url),location.href),source=u.pathname.includes('/remote/m1/')?'m1':u.pathname.includes('/remote/m2/')?'m2':null;if(source&&u.pathname.endsWith('/api/team-artifacts'))return json(window.__reviewFixturePage(u,location.href,{'same-team':[{id:'a'.repeat(64),uri:'coral://artifacts/'+'a'.repeat(64),name:'Same title.md',series_id:'same-series-id',produced_by:'Developer',session_id:'same-producer',available:true,tags:['for review'],created_at:new Date().toISOString(),goal_id:1,goal_title:'Same goal',version:3,opened_version:source==='m1'?1:3,new_comments:source==='m1'?2:0}]}));if(source&&u.pathname.endsWith('/star')){window.__remoteStars.push({path:u.pathname,method:opts.method});return json({starred:true});}return original(url,opts);};return true;})()`);
 await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
 await waitFor(`document.querySelectorAll('.nl-file').length===2`,'both source-qualified files remain in the native ledger');
 const headers=await ev(`[...document.querySelectorAll('.nl-group-head')].filter(g=>/#1.*Same goal/.test(g.textContent)).map(g=>g.textContent)`);
 assert.equal(headers.length,2,'same goal ID stays two computer-qualified groups');
 assert.ok(headers.some(t=>t.includes('Laptop'))&&headers.some(t=>t.includes('Desktop')),JSON.stringify(headers));
 await ev(`document.querySelector('.inbox-fold-all').click();true`);
 const sources=await ev(`[...document.querySelectorAll('.nl-file')].map(r=>({source:r.dataset.needsKey.split(':')[0],fresh:!!r.querySelector('.nl-new'),version:r.querySelector('.nl-version')?.textContent}))`);
 assert.equal(sources.find(r=>r.source==='m1').fresh,true,'Laptop retains its independent new-version/comment attention');
 assert.equal(sources.find(r=>r.source==='m2').fresh,false,'Desktop remains independently read and without news');
 assert.ok(sources.every(r=>r.version==='version 3'),'both source records keep the version label');
 if(width===1280){
  await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('artifacts')).then(()=>true)`);
  await waitFor(`!!document.querySelector('tr[data-key^="m2:"] button.dt-star')`,'existing Artifacts star for the Desktop file');
  await ev(`document.querySelector('tr[data-key^="m2:"] button.dt-star').click();true`);
  await waitFor(`window.__remoteStars.length===1`,'source-scoped star uses the existing Artifacts owner');
  assert.deepEqual(await ev(`window.__remoteStars`),[{path:'/api/remote/m2/api/artifacts/'+'a'.repeat(64)+'/star',method:'PUT'}]);
 }

}
console.log('PASS grouping and star pins on desktop/phone plus two-computer Hub routing, producer overflow and row isolation');
}finally{await removeBoards(ev,[team]).catch(()=>{});await client.close();}})().catch(e=>{console.error(e);process.exit(1);});
