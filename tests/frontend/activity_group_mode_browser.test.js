// Group by in Activity (#14729): the Filters panel has Group by: None (the default: every record a row), Goal (one heading per goal, a task's records plain rows in it, and each row still names its task), Goal and task (a heading per task, as built). 1280 and 390 px. Derived from activity_threads_browser.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.addScriptToEvaluateOnNewDocument({source:`localStorage.removeItem('coral-inbox-group-review-goal');localStorage.removeItem('coral-inbox-group-mode');localStorage.removeItem('coral-inbox-task-open');localStorage.removeItem('coral-inbox-activity-filters');`});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');
   await ev(`(()=>{const base={team:'alpha',actor:'operator',source:'local',goal_id:1,goal_title:'Ship <b>the release</b>',task_id:11,task_title:'Write the plan',item_kind:'question',asker:'Reviewer'};window.__activityRows=['approve','changes','deny','answer','dismiss'].map((action,i)=>({...base,id:10+i,action,title:'Object '+action,note:action==='answer'?'@Reviewer Yes, keep @Designer informed.':'My words for '+action,item_id:String(i+1),at:new Date(Date.now()-i*60000).toISOString()}));window.__activityRows.push({...base,id:30,team:'beta',title:'Different team',action:'approve',note:'Beta words',item_id:'30',at:new Date().toISOString()},{...base,id:31,task_id:null,title:'Goal-level object',action:'answer',note:'Goal words',item_id:'31',at:new Date().toISOString()},{...base,id:32,goal_id:null,task_id:null,title:'Legacy object',action:'dismiss',note:'Legacy words',item_id:'32',at:new Date().toISOString()});const real=window.fetch;window.fetch=(u,o)=>new URL(String(u),location.href).pathname==='/api/activity'?Promise.resolve(Response.json({actions:window.__activityRows,check:{intact:true,rows:8}})):real(u,o);window.switchNavTab('hub-inbox');return import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('activity'))})()`);
   await waitFor(`document.querySelectorAll('.activity-folder tr.dt-row').length===8`,'ungrouped Activity rows');
   const open=async()=>{if(!(await ev(`!!document.querySelector('.inbox-activity-group-toggle')&&document.querySelector('.inbox-activity-group-toggle').getClientRects().length>0`)))await ev(`document.getElementById('inbox-activity-toggle').click();true`);await waitFor(`document.querySelector('.inbox-activity-group-toggle select')?.getClientRects().length>0`,width+': Activity Group by option');};
   const set=v=>ev(`(()=>{const s=document.querySelector('.inbox-activity-group-toggle select');s.value='${v}';s.dispatchEvent(new Event('change',{bubbles:true}))})();true`);
   await open();
   const opt=await ev(`(()=>{const t=document.querySelector('.inbox-activity-group-toggle'),s=t.querySelector('select');return{label:t.querySelector('.list-bar-field-label').textContent,options:[...s.options].map(o=>o.text),value:s.value,h:Math.round(s.getBoundingClientRect().height)}})()`);
   assert.deepEqual(opt.options,['None','Goal','Goal and task'],width+': three choices');assert.equal(opt.label,'Group by');assert.equal(opt.value,'none',width+': None by default');assert.ok(width>760||opt.h>=44,width+': a phone target '+JSON.stringify(opt));
   assert.equal(await ev(`document.querySelectorAll('.activity-folder .dt-group').length`),0,width+': None: no headings, the list as it was');
   await set('goal');await waitFor(`document.querySelectorAll('.activity-folder .dt-group').length>=2`,width+': Goal: goal headings');
   assert.equal(await ev(`document.querySelectorAll('.activity-folder .dt-group-task').length`),0,width+': Goal: no task headings');
   assert.ok(await ev(`document.querySelectorAll('.activity-folder tr.dt-row').length`)>=8,width+': Goal: the records are plain rows under their goal (not shut with a task)');
   assert.ok(await ev(`[...document.querySelectorAll('.activity-folder tr.dt-row')].some(r=>/Write the plan/.test(r.textContent))`),width+': Goal: a row still names its task');
   await set('task');await waitFor(`document.querySelectorAll('.activity-folder .dt-group-task').length===2`,width+': Goal and task: task headings');
   assert.equal(await ev(`localStorage.getItem('coral-inbox-group-mode')`),'task',width+': kept in this browser');
   await set('none');await waitFor(`document.querySelectorAll('.activity-folder .dt-group').length===0`,width+': None again');
  }
  console.log('PASS Activity Group by: None, Goal, Goal and task, kept, at desktop and phone');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
