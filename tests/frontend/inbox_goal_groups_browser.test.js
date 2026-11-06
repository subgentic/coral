// #13888/#13889: real Needs you table, grouping, source identity and accessible pin control.
const assert=require('node:assert/strict');const fs=require('node:fs');
const {connect}=require('./agent_view_harness');const {coralReady}=require('./helpers/wait');
const {setupHubWorld}=require('./helpers/hub_world');
const {removeBoards}=require('./helpers/board_cleanup');const BASE=require('./test_base').BASE;
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const team='goal-groups-'+Date.now().toString(36);
try{await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Page.addScriptToEvaluateOnNewDocument({source:"localStorage.removeItem('coral-inbox-group-review-goal');"});
for(const [width,theme] of [[1280,'light'],[390,'light'],[1280,'dark'],[390,'dark']]){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});true`);
 await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Dev',job_title:'Developer'})}).then(r=>r.status)`);
 await ev(`(()=>{localStorage.removeItem('coral-inbox-group-review-goal');const original=window.fetch.bind(window),json=b=>Promise.resolve(Response.json(b)),hex=n=>n.toString(16).padStart(64,'0');window.__groupCalls=[];window.__groupRows=Array.from({length:13},(_,i)=>({id:hex(i+1),name:'Document '+(i+1)+'.md',uri:'coral://artifacts/'+hex(i+1),produced_by:'Developer',session_id:'same-producer',created_at:new Date(Date.now()-i*60000).toISOString(),media_type:'text/markdown',available:true,tags:['for review'],goal_id:i<2?1:i===2?2:null,goal_title:i<2?'Update reliability':i===2?'Accessibility':'',starred:i===12,series_id:'series-'+i}));window.fetch=(url,opts={})=>{const u=new URL(String(url),location.href);if(u.pathname==='/api/board/${team}/artifacts')return json({artifacts:u.searchParams.get('tag')==='for review'?window.__groupRows:[],has_more:false});if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.endsWith('/star')){window.__groupCalls.push({path:u.pathname,method:opts.method});const a=window.__groupRows.find(a=>u.pathname.includes(a.id));a.starred=opts.method==='PUT';return json({starred:a.starred});}return original(url,opts);};return true;})()`);
 await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
 await waitFor(`document.querySelectorAll('.inbox-review-star').length>=11`,'pins bypass producer cap');
 assert.equal(await ev(`document.querySelector('.inbox-needs-results .dt-row [data-review-artifact]')?.dataset.reviewArtifact`),'d'.padStart(64,'0'),'old pinned document comes first');
 assert.equal(await ev(`document.querySelector('.inbox-group-review-toggle input').checked`),false,'grouping initially off');
 await ev(`document.querySelector('.inbox-group-review-toggle input').click();true`);
 await waitFor(`document.querySelectorAll('.inbox-needs-results .dt-group').length===4`,'pins plus two goals and No goal');
 const headings=await ev(`[...document.querySelectorAll('.inbox-needs-results .dt-group')].map(r=>r.textContent)`);
 assert.match(headings[0],/Starred for review/);assert.match(headings[1],/Goal #1/);assert.match(headings[2],/Goal #2/);assert.match(headings[3],/No goal/);
 const targets=await ev(`[...document.querySelectorAll('.inbox-review-star')].map(b=>{const r=b.getBoundingClientRect();return {width:r.width,height:r.height,pressed:b.getAttribute('aria-pressed'),pointer:getComputedStyle(b).pointerEvents};})`);
 assert.ok(targets.every(t=>t.width>=44&&t.height>=44&&t.pointer!=='none'),JSON.stringify(targets));
 const overlap=await ev(`(()=>{const intersect=(a,b)=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;return [...document.querySelectorAll('.inbox-review-star')].flatMap(b=>{const row=b.closest('tr'),icon=row.querySelector('.inbox-kind-icon'),text=row.querySelector('.inbox-review-name'),wait=row.querySelector('.inbox-review-wait');return [icon&&text&&intersect(icon.getBoundingClientRect(),text.getBoundingClientRect()),wait&&getComputedStyle(wait).display!=='none'&&intersect(b.getBoundingClientRect(),wait.getBoundingClientRect())].filter(Boolean);});})()`);
 assert.deepEqual(overlap,[],'icon, star and visible waiting text do not overlap at '+width+' '+theme);
 assert.equal(await ev(`document.querySelectorAll('#artifact-viewer:not([hidden])').length`),0);
 await ev(`document.querySelector('.inbox-review-star[aria-pressed="false"]').click();true`);
 await waitFor(`window.__groupCalls.length===1`,'one star write');
 assert.equal(await ev(`window.__groupCalls[0].method`),'PUT');
 assert.equal(await ev(`document.querySelectorAll('#artifact-viewer:not([hidden])').length`),0,'star does not open row');
 assert.equal(await ev(`localStorage.getItem('coral-inbox-group-review-goal')`),'true');
 const overflow=await ev(`document.documentElement.scrollWidth>innerWidth+1`);assert.equal(overflow,false,'no horizontal overflow at '+width);
 if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/goal-groups-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
}
await setupHubWorld({client,Page,Emulation,width:1280,height:900,mobile:false,inbox:'native',needs:true,hubPages:true});
for(const width of [1280,390]){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');
 await ev(`(()=>{const original=window.fetch.bind(window),json=b=>Promise.resolve(Response.json(b));window.__remoteStars=[];window.fetch=(url,opts={})=>{const u=new URL(String(url),location.href),source=u.pathname.includes('/remote/m1/')?'m1':u.pathname.includes('/remote/m2/')?'m2':null;if(source&&u.pathname.endsWith('/api/board/same-team/artifacts'))return json({artifacts:u.searchParams.get('tag')==='for review'?[{id:'a'.repeat(64),uri:'coral://artifacts/'+'a'.repeat(64),name:'Same title.md',series_id:'same-series-id',produced_by:'Developer',session_id:'same-producer',available:true,tags:['for review'],created_at:new Date().toISOString(),goal_id:1,goal_title:'Same goal'}]:[],has_more:false});if(source&&u.pathname.endsWith('/star')){window.__remoteStars.push({path:u.pathname,method:opts.method});return json({starred:true});}return original(url,opts);};return true;})()`);
 await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
 await waitFor(`document.querySelectorAll('.inbox-review-star').length===2`,'both source rows in native Hub Needs you');
 await ev(`document.querySelector('.inbox-group-review-toggle input').click();true`);
 await waitFor(`document.querySelectorAll('.inbox-needs-results .dt-group').length===2`,'same goal id remains two source groups');
 const labels=await ev(`[...document.querySelectorAll('.inbox-needs-results .dt-group')].map(g=>g.textContent)`);
 assert.ok(labels.some(t=>t.includes('Laptop'))&&labels.some(t=>t.includes('Desktop')),JSON.stringify(labels));
 await ev(`document.querySelector('tr[data-key^="m2:"] .inbox-review-star').click();true`);
 await waitFor(`window.__remoteStars.length===1`,'Hub source-scoped star');
 assert.deepEqual(await ev(`window.__remoteStars`),[{path:'/api/remote/m2/api/artifacts/'+'a'.repeat(64)+'/star',method:'PUT'}]);
}
console.log('PASS grouping and star pins on desktop/phone plus two-computer Hub routing, producer overflow and row isolation');
}finally{await removeBoards(ev,[team]).catch(()=>{});await client.close();}})().catch(e=>{console.error(e);process.exit(1);});
