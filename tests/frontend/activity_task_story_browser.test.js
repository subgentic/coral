// U4 (#14444): the story under a task in Activity: each task heading has its own Story control (shut by default, its own state, independent of the heading button that opens the decisions); on, a row under the heading reads GET /api/thread for that team and task. 1280 and 390 px, real clicks; /api/thread is answered by the page.
const assert=require('node:assert/strict');
const { touchTap } = require('./helpers/touch_tap');
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
   await ev(`(() => { const prev = window.fetch.bind(window), at = n => new Date(Date.now() - n * 60000).toISOString(); window.__threadCalls = []; const E = [
       { kind: 'task_event', id: 'e1', event: 'created', at: at(90) }, { kind: 'ask', id: 'a1', asker: 'Reviewer', line: 'Which plan do you prefer?', state: 'answered', at: at(80) },
       { kind: 'file', id: 'f1', name: 'plan.md', by: 'Reviewer', state: 'approved', at: at(70) }, { kind: 'decision', id: 'd1', action: 'approve', actor: 'operator', item_kind: 'file', title: 'plan.md', note: '', at: at(60) },
       { kind: 'reply', id: 'r1', from: 'Reviewer', text: 'Thanks, merging', at: at(30) }, { kind: 'task_event', id: 'e2', event: 'done', at: at(10) } ];
       window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname !== '/api/thread') return prev(url, opts); window.__threadCalls.push(u.search); return Promise.resolve(Response.json({ entries: [...E].reverse(), more: false, cursor: '' })); }; return true; })()`);
   const tap=async(index)=>{await ev(framesJs());const p=await ev(`(()=>{const b=document.querySelectorAll('.activity-folder .dt-group-toggle')[${index}];b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,h:r.height,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);assert.ok(p.h>=44&&p.hit,'on-screen task target '+JSON.stringify(p));if(width===390)await touchTap(client, { x:p.x,y:p.y });else{await client.Input.dispatchMouseEvent({type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});}};
   const box=async(index)=>{await ev(`document.querySelectorAll('.activity-folder .dt-group-task')[${index}].querySelector('.dt-group-story').scrollIntoView({block:'center'});true`);await ev(framesJs(8));return box1(index);}; // the taller cards need the scroll to finish before the control is measured
   const box1=async(index)=>ev(`(()=>{const tr=document.querySelectorAll('.activity-folder .dt-group-task')[${index}],b=tr.querySelector('.dt-group-story'),t=tr.querySelector('.dt-group-toggle');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect(),q=t.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,h:Math.round(r.height),w:Math.round(r.width),pressed:b.getAttribute('aria-pressed'),inside:r.top>=q.top-1&&r.bottom<=q.bottom+1,inView:r.right<=innerWidth&&r.left>=0,toggleH:Math.round(q.height)}})()`);
   const tapAt=async p=>{if(width===390)await touchTap(client, { x:p.x,y:p.y });else{await client.Input.dispatchMouseEvent({type:'mouseMoved',x:p.x,y:p.y});await client.Input.dispatchMouseEvent({type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});}};
   assert.equal(await ev(`document.querySelectorAll('.activity-folder .dt-group-story').length`),2,'each task heading has a Story control');
   assert.equal(await ev(`document.querySelectorAll('.activity-folder .thread-story').length`),0,'no story until it is asked for');
   let sb=await box(0);
   assert.ok(sb.pressed==='false'&&sb.h>=44&&sb.w>=44&&sb.inside&&sb.inView&&sb.toggleH>=44,'Story is a 44 px control inside its heading, unpressed: '+JSON.stringify(sb));
   await tapAt(sb);
   await waitFor(`!!document.querySelector('.activity-folder .thread-story .thread-list li')`,'the story is read and drawn under the heading',10000);
   const story=await ev(`(()=>{const head=document.querySelectorAll('.activity-folder .dt-group-task')[0],row=head.nextElementSibling,items=[...document.querySelectorAll('.activity-folder .thread-list li')].map(li=>li.textContent.replace(/\\s+/g,' ').trim());return{rowIsStory:!!row&&row.classList.contains('dt-story-row'),itemsShown:head.querySelector('.dt-group-toggle').getAttribute('aria-expanded'),pressed:head.querySelector('.dt-group-story').getAttribute('aria-pressed'),items,calls:window.__threadCalls,scroll:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`);
   assert.ok(story.rowIsStory&&story.pressed==='true','the story is a row under the heading');
   assert.equal(story.itemsShown,'false','the story is independent of the decisions: the task is still shut');
   assert.equal(story.items.length,6,'six entries: '+JSON.stringify(story.items));
   assert.ok(/Task created/.test(story.items[0])&&/Task done/.test(story.items[5]),'oldest first, ending on Task done: '+JSON.stringify([story.items[0],story.items[5]]));
   assert.ok(story.items.some(t=>/Approved/.test(t)&&/plan\.md/.test(t)),'your decision is in the story');
   assert.ok(story.calls.some(s=>/team=alpha/.test(s)&&/task=11/.test(s)&&/order=desc/.test(s)),'the read names the row\'s team and task: '+JSON.stringify(story.calls));
   assert.ok(story.scroll<=0,'no sideways scroll');
   if(process.env.CORAL_SCREENSHOT_DIR)require('node:fs').writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/activity-story-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   // the heading button opens the decisions without touching the story; Story shuts the story alone
   await tap(0);await waitFor(`document.querySelectorAll('.activity-folder tr.dt-row').length>2`,'the heading opens the task\'s actions');
   assert.ok(await ev(`!!document.querySelector('.activity-folder .thread-story')`),'the story stays while the actions open');
   sb=await box(0);await tapAt(sb);
   await waitFor(`!document.querySelector('.activity-folder .thread-story')`,'Story shuts the story');
   assert.ok(await ev(`document.querySelectorAll('.activity-folder tr.dt-row').length>2`),'and leaves the actions open');
  }
  console.log('PASS Activity: the story under a task, its own Story control, the read for that team and task, at desktop and phone');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
