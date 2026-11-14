// #16046: choosing a closed goal on Create offers explicit reopening; Cancel leaves it closed.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const {removeBoards}=require('./helpers/board_cleanup');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const B='closed-goal-'+Date.now().toString(36);
 const api=(method,path,body)=>ev(`fetch('/api/board/${B}'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body?JSON.stringify(JSON.stringify(body)):'undefined'}}).then(async r=>({status:r.status,json:await r.json()}))`);
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  assert.equal((await api('POST','/subscribe',{subscriber_id:'Boss',job_title:'Orchestrator'})).status,200);
  const made=await api('POST','/goals',{subscriber_id:'Operator',title:'Ship the pilot'});assert.equal(made.status,201);const id=made.json.id;
  assert.equal((await api('POST',`/goals/${id}/close`,{subscriber_id:'Operator',reason:'Finished',state:'done'})).status,200);
  for(const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await ev(`import((window.__coralStatic||'/static/')+'task_create.js').then(m=>m.showCreateTaskModal({project:'${B}'})).then(()=>true)`);
   await waitFor(`!!document.querySelector('#create-task-goal option[value="${id}"]')`,'closed goal offered');
   const choice=await ev(`document.querySelector('#create-task-goal option[value="${id}"]').textContent`);assert.match(choice,/closed.*reopen/i);
   assert.equal(await ev(`document.getElementById('create-task-goal').value`),'','a sole closed goal is never selected by default');
   await ev(`import((window.__coralStatic||'/static/')+'task_create.js').then(m=>m.hideCreateTaskModal()).then(()=>true)`);
   assert.equal((await api('GET',`/goals/${id}`)).json.state,'done','cancel does not reopen');
  }
  await ev(`import((window.__coralStatic||'/static/')+'task_create.js').then(m=>m.showCreateTaskModal({project:'${B}'})).then(()=>true)`);
  await ev(`document.getElementById('create-task-goal').value='${id}';document.getElementById('create-task-title').value='Additional work';document.getElementById('create-task-submit').click();true`);
  await waitFor(`document.getElementById('create-task-modal').style.display==='none'`,'task created');
  assert.equal((await api('GET',`/goals/${id}`)).json.state,'active','successful task creation reopens');
  console.log('PASS closed goal offered desktop/phone, cancel unchanged, task reopens');
 } finally {await removeBoards(ev,[B]).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
