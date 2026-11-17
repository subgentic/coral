// #17475: Settings restoration is welcome-only; closed goals are browser-local,
// and file/goal-done dismissals use their own Undo rather than that list.
const assert = require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const S=`(window.__coralStatic||'/static/')`;
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(()=>{const real=fetch;window.__writes=[];window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;const json=x=>Promise.resolve(new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}}));if(p==='/api/board/projects')return json([]);if(o.method==='PUT'&&p==='/api/settings'){window.__writes.push({p,body:JSON.parse(o.body)});return json({ok:true});}if(o.method==='POST'&&(/\\/review$/.test(p)||/\\/done-state$/.test(p))){window.__writes.push({p,body:JSON.parse(o.body)});return json({ok:true});}return real(u,o);};})()`);
   await ev(`window.showSettingsModal().then(()=>import(${S}+'settings_nav.js')).then(m=>m.openSettingsGroup('needs-you'))`);
   await waitFor(`!!document.getElementById('settings-inbox-muted')`,'Inbox settings host',8000);
   await ev(`import(${S}+'state.js').then(({state})=>{state.settings={...state.settings,inbox_welcome:'off',inbox_welcome_done:'agent',inbox_welcome_dismissed:'future-item,agent'};}).then(()=>import(${S}+'settings_inbox.js')).then(m=>m.drawDismissed())`);
   assert.equal(await ev(`document.querySelectorAll('#settings-inbox-dismissed button').length`),1,'only the known welcome item has Restore');
   assert.ok(await ev(`document.getElementById('settings-inbox-dismissed').textContent.includes('Start your first agent')`));
   assert.equal(await ev(`document.getElementById('settings-inbox-dismissed').textContent.includes('future-item')`),false,'no invented name for an unknown id');
   await ev(`document.querySelector('#settings-inbox-dismissed button').click();true`);
   await waitFor(`document.getElementById('settings-inbox-dismissed').hidden`,'restored list is empty',5000);
   await waitFor(`window.__writes.some(x=>x.body.inbox_welcome_dismissed==='future-item'&&x.body.inbox_welcome==='on')`,'Restore preserves an unknown id',5000);
   await ev(`import(${S}+'state.js').then(({state})=>{state.settings.inbox_welcome='off';});`);await ev(framesJs(3));
   // The goal carries its own browser-only dismissal and Undo.
   const closed=await ev(`(async()=>{const C=await import(${S}+'goal_closed_items.js'),W=await import(${S}+'welcome_swipe.js');window.__closedGoal={id:71,state:'done',title:'Closed goal',closed_by:'Worker',closed_at:new Date().toISOString(),created_by:'Operator'};localStorage.removeItem('coral_goal_closed_dismissed');window.__writes=[];const r=C.closedGoalRows([window.__closedGoal],()=> 'boundary-team',{});W.dismissWithUndo(r[0].welcome);await (await import(${S}+'settings_inbox.js')).drawDismissed();return {left:C.closedGoalRows([window.__closedGoal],()=> 'boundary-team',{}).length,local:JSON.parse(localStorage.getItem('coral_goal_closed_dismissed')),listed:!document.getElementById('settings-inbox-dismissed').hidden,writes:window.__writes};})()`);
   assert.equal(closed.left,0);assert.equal(closed.local.length,1);assert.equal(closed.listed,false);assert.deepEqual(closed.writes,[],'closed-goal Dismiss has no server write');
   await ev(`[...document.querySelectorAll('.toast')].find(t=>t.textContent.includes('Dismissed: Goal #71')).querySelector('button').click();true`);
   assert.equal(await ev(`import(${S}+'goal_closed_items.js').then(C=>C.closedGoalRows([window.__closedGoal],()=> 'boundary-team',{}).length)`),1,'closed-goal Undo restores the browser row');
   // Real review helpers retain their own decision/Undo route, never Settings.
   await ev(`(async()=>{window.__writes=[];const A=await import(${S}+'artifact_review.js');const row={id:'a'.repeat(64),name:'boundary.md',team:'boundary-team',tags:['for review']};const out=await A.ignoreRow('boundary-team',row);A.sayIgnored('boundary-team',row,out);})()`);
   await ev(`[...document.querySelectorAll('.toast')].find(t=>t.textContent.includes('Dismissed: boundary.md')).querySelector('button').click();true`);
   await waitFor(`window.__writes.some(x=>x.body.decision==='unignore')`,'file Undo uses the review route',5000);
   const file=await ev(`window.__writes`);assert.deepEqual(file.map(x=>x.body.decision),['ignore','unignore']);assert.ok(file.every(x=>x.p.endsWith('/review')));
   // A goal that looks done has its server-owned done-state and a working Undo.
   const done=await ev(`(async()=>{window.__writes=[];const G=await import(${S}+'goal_done.js');const g={id:72,board_id:'boundary-team',state:'active',title:'Looks done',rollup:{done:1}};const undo=await G.hideGoalDone('boundary-team',g,'ignore');await undo();await (await import(${S}+'settings_inbox.js')).drawDismissed();return {writes:window.__writes,listed:!document.getElementById('settings-inbox-dismissed').hidden,dismissed:(await import(${S}+'state.js')).state.settings.inbox_welcome_dismissed};})()`);
   assert.deepEqual(done.writes.map(x=>x.body.state),['dismiss','show']);assert.ok(done.writes.every(x=>x.p.endsWith('/done-state')));assert.equal(done.listed,false);assert.equal(done.dismissed,'future-item','non-welcome actions never join the Settings restoration list');
   console.log('PASS '+width+': unknown ids, local closed goals and separate review/goal-done Undo boundaries');
  }
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
