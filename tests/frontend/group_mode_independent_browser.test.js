// Group by is a choice per page (#22043, the Operator): changing it in Needs you no longer changes it in Activity, and the other way round. Each page reads and saves its own key
// (Needs you: coral-inbox-group-mode, Activity: coral-inbox-activity-group-mode). A choice stored under the old shared key carries over to both pages once, on the first load after the split.
// 1280 and 390 px. Activity's records are the fixture of activity_group_mode_browser.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const {removeBoards}=require('./helpers/board_cleanup');
const BASE=require('./test_base').BASE;
const KEYS=['coral-inbox-group-review-goal','coral-inbox-group-mode','coral-inbox-activity-group-mode','coral-inbox-task-open','coral-inbox-activity-filters'];
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const team='group-split-'+Date.now().toString(36);
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.addScriptToEvaluateOnNewDocument({source:`if(!sessionStorage.getItem('keep-group-keys')){${KEYS.map(k=>`localStorage.removeItem('${k}');`).join('')}}`}); // a load starts clean, except the carry-over loads below
  for(const width of [1280,390]){
   const at=width+': ';
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   const load=async()=>{await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');
    await ev(`(()=>{const base={team:'${team}',actor:'operator',source:'local',goal_id:1,goal_title:'Ship the release',task_id:11,task_title:'Write the plan',item_kind:'question',asker:'Reviewer'};window.__activityRows=['approve','changes','deny','answer','dismiss'].map((action,i)=>({...base,id:10+i,action,title:'Object '+action,note:'My words for '+action,item_id:String(i+1),at:new Date(Date.now()-i*60000).toISOString()}));window.__activityRows.push({...base,id:30,task_id:12,task_title:'Ship it',title:'Second task',action:'approve',note:'More words',item_id:'30',at:new Date().toISOString()});
     const hex=n=>n.toString(16).padStart(64,'0'),file=(n,name,goal,task)=>({id:hex(n),name,uri:'coral://artifacts/'+hex(n),produced_by:'Developer',session_id:'p'+n,created_at:new Date(Date.now()-n*60000).toISOString(),media_type:'text/markdown',available:true,tags:['for review'],goal_id:goal||null,goal_title:goal?'Split Group by':'',task_id:task||null,task_title:task?'Build it':'',series_id:'s'+n,version:1});
     window.__rows=[file(1,'Story one.md',1,11),file(2,'Story two.md',1,11),file(3,'Loose file.md',0,0)];
     const real=window.fetch.bind(window);window.fetch=(u,o)=>{const p=new URL(String(u),location.href);if(p.pathname==='/api/activity')return Promise.resolve(Response.json({actions:window.__activityRows,check:{intact:true,rows:6}}));if(p.pathname==='/api/team-artifacts')return Promise.resolve(Response.json(window.__reviewFixturePage(p,location.href,{'${team}':window.__rows})));return real(u,o)};return true})()`);
    await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Dev',job_title:'Developer'})}).then(r=>r.status)`);
    await ev(`window.switchNavTab('hub-inbox');true`);};
   const activity=async()=>{await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('activity')).then(()=>true)`);await waitFor(`document.querySelectorAll('.activity-folder .al-row, .activity-folder .al-group-head').length>0`,at+'Activity records',15000);
    if(!(await ev(`document.querySelector('.inbox-activity-group-toggle select')?.getClientRects().length>0`)))await ev(`document.getElementById('inbox-activity-toggle').click();true`);
    await waitFor(`document.querySelector('.inbox-activity-group-toggle select')?.getClientRects().length>0`,at+"Activity's Group by");};
   const needs=async()=>{await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('needs')).then(()=>true)`);await waitFor(`!!document.getElementById('inbox-needs-toggle')&&[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].some(r=>/Story one/.test(r.textContent))`,at+"Needs you's review files",20000);
    if(!(await ev(`document.querySelector('.inbox-group-review-toggle select')?.getClientRects().length>0`)))await ev(`document.getElementById('inbox-needs-toggle').click();true`); // Group by shows once there are files to group (a Needs you with none hides it)
    await waitFor(`document.querySelector('.inbox-group-review-toggle select')?.getClientRects().length>0`,at+"Needs you's Group by");};
   const value=cls=>ev(`document.querySelector('${cls} select').value`);
   const set=(cls,v)=>ev(`(()=>{const s=document.querySelector('${cls} select');s.value='${v}';s.dispatchEvent(new Event('change',{bubbles:true}))})();true`);
   const stored=k=>ev(`localStorage.getItem('${k}')`);
   const A='.inbox-activity-group-toggle',N='.inbox-group-review-toggle';
   // set Activity: Needs you stays
   await load();await activity();
   assert.equal(await value(A),'none',at+'Activity starts at None');
   await set(A,'task');await waitFor(`document.querySelectorAll('.activity-folder .al-subgroup-head').length===2`,at+'Activity: Goal and task headings');
   assert.equal(await stored('coral-inbox-activity-group-mode'),'task',at+"Activity's choice is saved under its own key");
   assert.notEqual(await stored('coral-inbox-group-mode'),'task',at+"Activity's choice is not written to Needs you's key");
   await needs();
   assert.equal(await value(N),'none',at+'Needs you is still None after Activity changed');
   assert.equal(await ev(`document.querySelectorAll('.inbox-needs-results .dt-group').length`),0,at+'Needs you draws no headings');
   // set Needs you: Activity stays
   await set(N,'goal');await waitFor(`document.querySelectorAll('.inbox-needs-results .dt-group:not(.dt-group-task)').length>=1`,at+'Needs you: Goal headings');
   assert.equal(await stored('coral-inbox-group-mode'),'goal',at+"Needs you's choice is saved under its key");
   assert.equal(await stored('coral-inbox-activity-group-mode'),'task',at+"Needs you's choice leaves Activity's key alone");
   await activity();
   assert.equal(await value(A),'task',at+'Activity is still Goal and task after Needs you changed');
   await waitFor(`document.querySelectorAll('.activity-folder .al-subgroup-head').length===2`,at+'Activity still draws its task headings');
   // both survive a reload, each its own
   await ev(`sessionStorage.setItem('keep-group-keys','1');true`);
   await load();await needs();assert.equal(await value(N),'goal',at+'a reload keeps Needs you at Goal');
   await activity();assert.equal(await value(A),'task',at+'a reload keeps Activity at Goal and task');
   // today's shared choice carries over to both, once
   await ev(`localStorage.removeItem('coral-inbox-activity-group-mode');localStorage.setItem('coral-inbox-group-mode','goal');true`);
   await load();await activity();
   assert.equal(await value(A),'goal',at+'the old shared choice carries over to Activity');
   assert.equal(await stored('coral-inbox-activity-group-mode'),'goal',at+'the carried choice is saved as Activity\'s own');
   await needs();assert.equal(await value(N),'goal',at+'the old shared choice is still Needs you\'s');
   await set(N,'none');
   await load();await activity();
   assert.equal(await value(A),'goal',at+'carried once: a later Needs you change is not copied again');
   await ev(`sessionStorage.removeItem('keep-group-keys');true`);
  }
  console.log('PASS Group by: Needs you and Activity keep their own choice; the shared one carries over once; 1280 and 390');
 }finally{await removeBoards(ev,[team]).catch(()=>{});await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
