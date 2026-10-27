// Real task routes on the isolated runner; stand-in agents give the dock explicit board identity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const B = 'own-tasks-' + Date.now().toString(36);
 const api = (method, route, body) => ev(`fetch(${JSON.stringify(route)}, {method:${JSON.stringify(method)}, headers:{'Content-Type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
 const snapshot = () => ev(`(()=>({titles:[...document.querySelectorAll('#board-task-list .board-task-desc')].map(e=>e.textContent.trim()).filter(x=>x!=='Task'),badge:document.getElementById('task-bar-count').textContent,label:document.getElementById('agentic-tab-tasks').getAttribute('aria-label'),count:document.querySelector('#board-task-bar .list-bar-count')?.textContent,toggle:[...document.querySelectorAll('#board-tasks-section label, #board-tasks-section button')].some(e=>/Show all team tasks/.test(e.textContent))}))()`);
 const show = async (name, id, orch) => {
  await ev(`window.__m.add(${JSON.stringify(name)},'S',1,{sleeping:false,board_project:${JSON.stringify(B)},board_is_orchestrator:${orch},board_subscriber_id:${JSON.stringify(id)},display_name:${JSON.stringify(orch?'Coordinator':'Orchestrator')}}); true`);
  await waitFor(`window.__qaState.liveSessions.some(s=>s.name===${JSON.stringify(name)})`,'stand-in live agent');
  await ev(`window.selectLiveSession(${JSON.stringify(name)},'claude',${JSON.stringify(name+'-id')},'local'); true`);
  await ev(`(()=>{const d=document.getElementById('agentic-state');if(d.getBoundingClientRect().width<50||d.classList.contains('collapsed'))(document.getElementById('panel-toggle-btn')||document.getElementById('popout-panel-toggle-btn'))?.click();document.getElementById('agentic-tab-tasks').click();return true})()`);
  await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'tasks.js');m.stopBoardTaskPoll();await m.loadBoardTasks(${JSON.stringify(B)});return true})()`);
 };
 const capture = async name => {
  if (!process.env.CORAL_SCOPE_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.CORAL_SCOPE_EVIDENCE_DIR,{recursive:true});
  const shot=await Page.captureScreenshot({format:'png'});
  fs.writeFileSync(path.join(process.env.CORAL_SCOPE_EVIDENCE_DIR,name+'.png'),Buffer.from(shot.data,'base64'));
  fs.writeFileSync(path.join(process.env.CORAL_SCOPE_EVIDENCE_DIR,name+'.json'),JSON.stringify(await snapshot(),null,2));
 };
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();
  await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
  for (const [id,title] of [['Lead','Orchestrator'],['WorkerA','Backend'],['WorkerB','Reviewer'],['WorkerC','QA']]) assert.equal((await api('POST',`/api/board/${B}/subscribe`,{subscriber_id:id,job_title:title,session_name:id+'-session'})).status,200);
  const mk = async(title,id)=>{const r=await api('POST',`/api/board/${B}/tasks`,{title,assigned_to:id,created_by:'Operator'});assert.equal(r.status,201);return r.body.id;};
  await mk('Alpha owned','WorkerA');
  const done=await mk('Alpha finished','WorkerA');assert.equal((await api('POST',`/api/board/${B}/tasks/${done}/complete`,{subscriber_id:'WorkerA',message:'done'})).status,200);
  const parent=await mk('Beta submitted','WorkerB');
  assert.equal((await api('POST',`/api/board/${B}/tasks/claim`,{subscriber_id:'WorkerB',task_id:parent})).status,200);
  assert.equal((await api('POST',`/api/board/${B}/tasks/${parent}/submit-review`,{subscriber_id:'WorkerB',reason:'QA fixture review'})).status,200);
  assert.equal((await api('POST',`/api/board/${B}/tasks/${parent}/review`,{subscriber_id:'Lead',reviewers:['WorkerA']})).status,200);
  await mk('Beta owned','WorkerB');await mk('Unassigned task','');
  await show('worker-a','WorkerA',false);
  let s=await snapshot();assert.equal(s.titles.length,3,JSON.stringify(s));assert(s.titles.includes('Alpha owned'));assert(s.titles.includes('Alpha finished'));assert(s.titles.some(t=>t.startsWith('Review #')));assert.equal(s.badge,'2/3');assert.equal(s.label,'Tasks, 2 of 3 open');assert.equal(s.count,'3 tasks');assert.equal(s.toggle,false);await capture('worker');
  const cols=()=>ev(`({heads:[...document.querySelectorAll('#board-task-list thead th')].filter(h=>h.getClientRects().length).map(h=>h.dataset.key),cells:[...(document.querySelector('#board-task-list tbody tr')||{cells:[]}).cells].map(c=>c.dataset.key),agentFilter:(()=>{const e=document.getElementById('tk-assignee');return !!e&&!e.closest('label').hidden;})()})`);
  let c=await cols();assert.deepEqual(c.cells,['state','task','who'],"an agent's own dock shows status, task and avatar: "+JSON.stringify(c));assert.equal(c.agentFilter,false,"and has no Agent filter (#8035)");
  for(const w of [680,420]){await ev(`document.getElementById('agentic-state').style.width='${w}px';true`);await ev(`new Promise(r=>setTimeout(r,500))`);await capture('own-dock-'+w);if(w===420){const st=await ev(`(()=>{const e=document.querySelector('#board-task-list tbody tr td[data-key=state]');return e&&e.scrollWidth<=e.clientWidth+1?Math.round(e.clientWidth):-1})()`);assert(st>40,'a folded row keeps its whole status chip: '+st);}} // sleep-ok: the dock's width settles
  await ev(`document.getElementById('agentic-state').style.width='';true`);
  await ev(`document.querySelector('[data-on-click=task-create-show]').click(); true`);await waitFor(`document.getElementById('create-task-assignee')?.value==='WorkerA' && document.getElementById('create-task-modal').getClientRects().length>0`,'new task defaults to stable member identity');await capture('new-task-worker');await ev(`window.hideCreateTaskModal();true`);
  await show('worker-b','WorkerB',false);s=await snapshot();assert(s.titles.every(t=>t.startsWith('Beta')),JSON.stringify(s));assert.equal(s.badge,'1/1');assert.equal(s.count,'1 task');
  await show('lead','Lead',true);s=await snapshot();assert.equal(s.titles.length,6);assert.equal(s.badge,'1/6','orchestrator badge remains done of total');assert.equal(s.count,'6 tasks');assert.equal(s.toggle,false);await capture('orchestrator');
  c=await cols();assert.deepEqual(c.cells,['state','task','who'],'the orchestrator spans the team: Agent stays: '+JSON.stringify(c));assert.equal(c.agentFilter,true,'and so does the Agent filter');
  await show('worker-a','WorkerA',false);s=await snapshot();assert.equal(s.titles.length,3,'switching agents restores scope');assert.equal(s.badge,'2/3');
  for(let i=0;i<55;i++){const id=await mk('Alpha archived '+i,'WorkerA');assert.equal((await api('POST',`/api/board/${B}/tasks/${id}/complete`,{subscriber_id:'WorkerA',message:'fixture done'})).status,200);}
  await show('worker-a','WorkerA',false);s=await snapshot();assert.equal(s.badge,'2/58');assert.equal(s.count,'58 tasks');assert.equal(s.titles.length,52,'all own open plus first 50 done');
  await ev(`document.querySelector('#board-task-list .dt-more').click();true`);await waitFor(`document.querySelectorAll('#board-task-list .board-task-desc').length===58`,'older own completed page');s=await snapshot();assert.equal(s.titles.length,58);assert(s.titles.every(t=>t.startsWith('Alpha')||t.startsWith('Review #')));
  await ev(`(()=>{const q=document.getElementById('tk-search');q.value='Unassigned';q.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await waitFor(`document.querySelector('#board-task-bar .list-bar-count')?.textContent==='0 of 58'`,'worker search cannot show another agent tasks');assert.equal((await snapshot()).titles.length,0);
  await show('empty-worker','WorkerC',false);s=await snapshot();assert.equal(s.titles.length,0);assert.equal(s.badge,'');assert.equal(s.count,'0 tasks');
  console.log('PASS worker own tasks and review, scoped open/total badge and count, orchestrator all tasks, no toggle, stable assignee preset, agent switching');
 } finally {await api('DELETE',`/api/board/${B}`).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exit(1)});
