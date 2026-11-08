// #14524: count actual Hub API dispatches before Needs you paints under remote latency.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {setupHubWorld,BASE}=require('./helpers/hub_world');
(async()=>{
 const {client,Page,Emulation,ev,waitFor}=await connect();
 try{
  await setupHubWorld({client,Page,Emulation,width:1280,height:900,mobile:false,inbox:'native',needs:true});
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{
   const slowInventory=new URL(location.href).searchParams.has('slow_inventory');
   const real=window.fetch, calls=[],running={},peak={};window.__loadCalls=calls;window.__loadPeak=peak;
   const observe=()=>{if(window.__needsPaint)return;const list=document.querySelector('#group-table-view .inbox-needs-results');if(list&&list.getClientRects().length&&list.textContent.includes('Confirm the release plan') && window.__loadCalls.some(c=>c.source==='m2'&&c.path==='/api/operator-asks'))window.__needsPaint=performance.now();};
   new MutationObserver(observe).observe(document,{childList:true,subtree:true,attributes:true});
   window.fetch=async(u,o={})=>{const url=new URL(String(u),location.href);if(!url.pathname.startsWith('/api/'))return real(u,o);const match=url.pathname.match(/^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/),source=match?match[1]:'hub',path=match?match[2]:url.pathname;const record={source,path,query:url.search,start:performance.now()};calls.push(record);running[source]=(running[source]||0)+1;peak[source]=Math.max(peak[source]||0,running[source]);try{
    if(!match&&slowInventory&&['/api/servers','/api/sessions/live'].includes(path))await new Promise(resolve=>setTimeout(resolve,700)); // sleep-ok: delayed computer inventory
    if(match)await new Promise(resolve=>setTimeout(resolve,235)); // sleep-ok: controlled Hub round-trip latency, not a readiness wait
    if(!match&&path==='/api/operator-asks')return Response.json({error:'not found'},{status:404});
    if(match&&path==='/api/operator-asks')return Response.json([{kind:'ask',id:41,board:'same-team',asker:'Lead',text:'Confirm the release plan',at:new Date().toISOString()}]);
    const response=await real(u,o);
    if(path==='/api/sessions/live'&&!match){window.__inventoryArrived=performance.now();const body=await response.json();body.sessions=Array.from({length:14},(_,i)=>({...body.sessions[i%body.sessions.length],session_id:'load-agent-'+i,name:'load-agent-'+i,board_project:i===0?'same-team':'team-'+(i%7),server:i<7?'m1':'m2'}));return Response.json(body);}
    return response;
   }finally{record.end=performance.now();running[source]--;}};
  })()`});
  for(const slow of [false,true]){
  await Page.navigate({url:BASE+'/inbox/needs'+(slow?'?slow_inventory=1':'')});await Page.loadEventFired();
  await waitFor(`!!window.__needsPaint`,'first visible Needs you row',20000);
  const report=await ev(`(()=>{const paint=window.__needsPaint,calls=window.__loadCalls.filter(c=>c.start<=paint),sources=[...new Set(calls.map(c=>c.source))];return{paint,calls,peak:window.__loadPeak,bySource:Object.fromEntries(sources.map(source=>{const list=calls.filter(c=>c.source===source);const depths=[];list.forEach((call,i)=>depths.push(1+Math.max(0,...list.slice(0,i).map((prior,j)=>prior.end&&prior.end<=call.start?depths[j]:0))));return[source,{count:list.length,capacityWaves:Math.ceil(list.length/6),observedWaves:Math.max(0,...depths)}]}))}})()`);
  fs.writeFileSync('/private/tmp/ui14524-first-paint'+(slow?'-slow':'')+'.json',JSON.stringify(report,null,2));
  console.log('Hub first paint requests '+JSON.stringify(report));
  if(slow)assert.ok(await ev(`window.__loadCalls.filter(c=>c.source!=='hub'&&c.path==='/api/operator-asks').every(c=>c.start>=window.__inventoryArrived)`),'slow inventory starts no question source read before computers arrive');
  for(const [source,count] of Object.entries(report.bySource))if(source!=='hub')assert.ok(count.count<=6,source+': at most six remote calls before first Needs you paint, got '+count.count);
  assert.ok(!report.calls.some(c=>new URLSearchParams(c.query).get('tag')==='saved'),'unopened Saved sends no artifact reads before first paint');
  assert.ok(!report.calls.some(c=>c.path.endsWith('/distill-knowledge')),'hidden Agents team chips defer distill reads');
  assert.ok(!report.calls.some(c=>c.source==='hub'&&c.path==='/api/pinned-folders'),'cloud startup does not ask Hub origin for computer pins');
  assert.ok(!report.calls.some(c=>/\/board\/[^/]+\/artifacts$/.test(c.path)&&/tag=/.test(c.query)),'no per-board Saved/review fan-out before Needs you paints');
  await waitFor(`window.__loadCalls.some(c=>c.source==='m2'&&c.path==='/api/pinned-folders')`,'computer pins load after inventory arrives');
  await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('saved'))`);
  assert.equal(await ev(`window.__loadCalls.filter(c=>new URLSearchParams(c.query).get('tag')==='saved').length`),0,'framed Hub Saved does not activate native file reads');
  await ev(`import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m=>m.activateSavedReviews())`);
  await waitFor(`window.__loadCalls.some(c=>c.source==='m2'&&new URLSearchParams(c.query).get('tag')==='saved')`,'explicit Saved-file cache activation reads both computers');
  await ev(`import((window.__coralStatic||'/static/')+'team_availability.js').then(m=>m.refreshTeamAvailability('@m2/same-team',true))`);
  assert.ok(await ev(`window.__loadCalls.some(c=>c.source==='m2'&&c.path==='/api/board/same-team/status')`),'explicit team status remains available');
  const gaps=await ev(`(async()=>{window.__skillsFail=['m2'];const base=window.__coralStatic||'/static/',m=await import(base+'needs_skills.js'),{serverUrl}=await import(base+'server_base.js');await m.loadPendingSkills({hub:true,sources:['m1','m2'],urlOf:serverUrl});return (await import(base+'needs_incomplete.js')).readGaps();})()`);
  assert.ok(gaps.some(g=>g.kind==='skills'&&g.source==='m2'),'real computer failure remains visible');
  assert.ok(!gaps.some(g=>g.source==='hub'||g.source==='local'),'no invented Hub-origin skill failure');
  const recovered=await ev(`(async()=>{window.__skillsFail=[];const base=window.__coralStatic||'/static/',m=await import(base+'needs_skills.js'),{serverUrl}=await import(base+'server_base.js');await m.loadPendingSkills({hub:true,sources:['m1','m2'],urlOf:serverUrl});return (await import(base+'needs_incomplete.js')).readGaps();})()`);
  assert.ok(!recovered.some(g=>g.kind==='skills'),'successful computer read clears its own failure note');
  }
 }finally{await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
