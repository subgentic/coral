// U3: the same goal/task fold as Needs you, with readable decisions and personal words.
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
   await ev(`document.getElementById('inbox-activity-toggle').click();true`);
   await waitFor(`document.querySelector('.inbox-activity-group-toggle select')?.getClientRects().length>0`,'Activity Group by goal option');
   await ev(`(()=>{const s=document.querySelector('.inbox-activity-group-toggle select');s.value='task';s.dispatchEvent(new Event('change',{bubbles:true}))})();document.getElementById('inbox-activity-toggle').click();true`);
   await waitFor(`document.querySelectorAll('.activity-folder .dt-group-task').length===2`,'source-qualified task headings');
   assert.equal(await ev(`document.querySelectorAll('.activity-folder tr.dt-row').length`),2,'decided tasks start shut; loose/legacy rows stay visible');
   assert.equal(await ev(`!!document.querySelector('.activity-folder .dt-group b')`),false,'goal text never becomes HTML');
   const headings=await ev(`[...document.querySelectorAll('.activity-folder .dt-group')].map(e=>e.textContent)`);
   assert.equal(headings.filter(t=>t.startsWith('Goal #1')).length,2,'same goal number in two teams never merges');
   assert.ok(headings.some(t=>t.startsWith('Not linked to a goal')),'rows without a recorded goal are honestly labelled');
   const tap=async(index)=>{await ev(framesJs());const p=await ev(`(()=>{const b=document.querySelectorAll('.activity-folder .dt-group-toggle')[${index}];b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,h:r.height,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);assert.ok(p.h>=44&&p.hit,'on-screen task target '+JSON.stringify(p));if(width===390)await client.Input.synthesizeTapGesture({x:p.x,y:p.y,gestureSourceType:'touch'});else{await client.Input.dispatchMouseEvent({type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});}};
   await tap(0);await waitFor(`document.querySelectorAll('.activity-folder tr.dt-row').length>2`,'first task opens');
   assert.ok((await ev(`[...document.querySelectorAll('.activity-folder .dt-group-toggle')].map(b=>b.getAttribute('aria-expanded'))`)).includes('false'),'other team stays shut');
   await tap(1);await waitFor(`document.querySelectorAll('.activity-folder tr.dt-row').length===8`,'both tasks open',5000,`({width:innerWidth,rows:document.querySelectorAll('.activity-folder tr.dt-row').length,heads:[...document.querySelectorAll('.activity-folder .dt-group-toggle')].map(b=>[b.textContent,b.getAttribute('aria-expanded')]),kept:localStorage.getItem('coral-inbox-task-open')})`);
   if(process.env.CORAL_SCREENSHOT_DIR)require('node:fs').writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/activity-threads-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   assert.ok(await ev(`[...document.querySelectorAll('.activity-folder .dt-group')].every(tr=>{const next=tr.nextElementSibling;return !next?.classList.contains('dt-row')||tr.querySelector('th').getBoundingClientRect().bottom<=next.getBoundingClientRect().top+1})`),'group headings never cover their first action');
   const words=await ev(`document.querySelector('.activity-folder').textContent`);
   for(const label of ['Approved','Asked for changes','Denied','Answered','Dismissed'])assert.ok((await ev(`[...document.querySelectorAll('.activity-decision')].map(e=>e.textContent)`)).includes(label),label+' is a visible Decision chip');
   assert.ok(words.includes('My words for changes')&&words.includes('My words for deny')&&words.includes('My words for dismiss'),'personal words stay with decisions');
   assert.ok(words.includes('Yes, keep @Designer informed.')&&!words.includes('@Reviewer'),'answer formatting preserves other mentions');
   assert.ok(!(await ev(`document.querySelector('.activity-folder').textContent`)).includes('Waiting on you'),'decided rows never imply an unread request');
   await ev(`document.getElementById('inbox-activity-toggle').click();const e=document.getElementById('inbox-activity-decision');e.value='changes';e.dispatchEvent(new Event('change',{bubbles:true}));true`);
   await waitFor(`document.querySelectorAll('.activity-folder tr.dt-row').length===1`,'Decision filter selects Asked for changes');
   assert.ok(await ev(`document.querySelector('.activity-folder tr.dt-row').textContent.includes('My words for changes')`));
   assert.ok(await ev(`document.querySelector('.activity-folder .dt-group-task').textContent.includes('1 shown')`),'counts reflect filtered rows');
   if(process.env.CORAL_SCREENSHOT_DIR)require('node:fs').writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/activity-decision-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow');
  }
  console.log('PASS Activity goal/task folds, source identity, Decision chips, words and filter at desktop/phone');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
