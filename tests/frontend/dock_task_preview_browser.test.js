// #8788: the agent's task uses the shared artifact preview pane, preserving the list.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const board = 'task-preview-' + Date.now().toString(36);
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const failures=[];
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await ev(`window.__coralReady.then(()=>true)`);
  const api=(m,p,b)=>ev(`fetch(${JSON.stringify(p)},{method:${JSON.stringify(m)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(b))}}).then(r=>r.status)`);
  assert.equal(await api('POST',`/api/board/${board}/subscribe`,{subscriber_id:'Boss',job_title:'Orchestrator'}),200);
  for(let i=1;i<=20;i++)assert.equal(await api('POST',`/api/board/${board}/tasks`,{subscriber_id:'Boss',title:'Preview task '+i,body:'Task description '+i,priority:'medium',assigned_to:'Boss'}),201);
  for(const width of [1280,390]){try{
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await ev(`window.__coralReady.then(()=>true)`);
   await openBoardTasksTab({ev,waitFor},board);
   await waitFor(`document.querySelectorAll('#board-task-list .board-task-item').length>=2`,'task list');
   const before=await ev(`(()=>{const r=document.querySelector('#board-task-list .board-task-item');r.querySelector('.board-task-name').scrollIntoView({block:'nearest'});window.__previewOpener=r;return {url:location.pathname,title:r.querySelector('.board-task-name').textContent,scroll:document.getElementById('agentic-panel-tasks').scrollTop};})()`);
   await ev(`window.__previewOpener.querySelector('.board-task-name').click();true`);
   await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`,'task detail in shared preview pane',7000);
   assert.equal(await ev(`location.pathname`),before.url,'opening keeps the agent URL');
   assert.equal(await ev(`document.getElementById('agentic-panel-tasks').scrollTop`),before.scroll,'list scroll stays put');
   assert.equal(await ev(`window.__previewOpener.getAttribute('aria-current')`),'true','clicked row remains highlighted');
   const detail=await ev(`document.querySelector('#preview-pane .team-task-page').textContent`);
   for(const label of ['Assigned to','Goal','Priority','Created','Description'])assert.ok(detail.includes(label),label+' remains in detail');
   await waitFor(`document.querySelector('#preview-pane .team-task-page').textContent.includes('Workflow')`,'Workflow section');
   assert.ok(await ev(`[...document.querySelectorAll('#preview-pane .preview-tab')].some(e=>e.textContent.includes(${JSON.stringify(before.title)}))`),'tab uses task title');
   assert.ok(await ev(`!!document.getElementById('preview-max-btn')&&!!document.querySelector('#preview-pane .preview-tab-close')`),'shared preview controls');
   const dir=process.env.CORAL_SCREENSHOT_DIR||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'out'));
   if(dir){fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await setTheme(ev,theme);fs.writeFileSync(path.join(dir,`dock-task-preview-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
   if(width===390){await ev(`document.getElementById('preview-full-back').click();true`);await waitFor(`document.getElementById('agentic-panel-tasks').getClientRects().length>0`,'Back restores list');}
   else await ev(`document.querySelector('#preview-pane .preview-tab-close').click();true`);
   assert.equal(await ev(`document.getElementById('agentic-panel-tasks').scrollTop`),before.scroll,'closing preserves list scroll');
  }catch(e){failures.push(width+': '+e.message);console.error(failures.at(-1));}}
  assert.deepEqual(failures,[]);
 }finally{await removeBoards(ev,[board]);await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
