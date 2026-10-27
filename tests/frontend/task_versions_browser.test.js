// #8951: task edits retain immutable history, and restoring text creates a newer version.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const sceneShots = require('./helpers/scene_shots');
const BASE = require('./test_base').BASE;
(async () => {
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const capture=sceneShots(Page,'task-versions');
 const shot=async name=>{await ev(`document.querySelectorAll('.toast').forEach(e=>e.remove());true`);await capture(name);};
 const board='versions-'+Date.now().toString(36);
 const api=(method,path,body)=>ev(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body?JSON.stringify(JSON.stringify(body)):'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
 const click=word=>ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar button')].find(e=>e.textContent===${JSON.stringify(word)}).click();true`);
 try {
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await ev(`window.__coralReady.then(()=>true)`);
 for(const width of [1280,390]) {
  await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
  const made=await api('POST',`/api/board/${board}/tasks`,{subscriber_id:'Operator',title:'Original task '+width,priority:'medium'});assert.equal(made.status,201);
  const id=made.body.id;
  await ev(`window.openTeamPage(${JSON.stringify(board)},{tab:'tasks',item:${id}});true`);
  await waitFor(`!!document.querySelector('#team-panel-item #team-task-title')`,'task page');
  await waitFor(`[...document.querySelectorAll('#team-panel-item .goals-pinbar button')].some(e=>e.textContent==='Edit')`,'Edit action');
  await click('Edit');await waitFor(`!!document.getElementById('task-edit-title')`,'edit form');
  await ev(`document.getElementById('task-edit-title').value='Edited task ${width}';document.getElementById('task-edit-priority').value='high';true`);await click('Save');
  await waitFor(`document.getElementById('team-task-title')?.textContent.includes('edited, v2')`,'edited version indicator');
  await waitFor(`!!document.querySelector('.task-version-history')`,'version history');
  await ev(`document.querySelector('.task-version-history').open=true;true`);
  await waitFor(`document.querySelector('.task-version-history').textContent.includes('Original task ${width} → Edited task ${width}')`,'old and new text in the version diff');
  await ev(`[...document.querySelectorAll('.task-version-history details')][0].open=true;true`);await shot(`${width}-v2-diff`);
  const history=await api('GET',`/api/board/${board}/tasks/${id}/history`);assert.deepEqual(history.body.map(x=>x.version),[1,2]);assert.equal(history.body[0].snapshot.title,'Original task '+width);
  await ev(`[...document.querySelectorAll('.task-version-history button')].find(e=>e.textContent==='Restore v1 as a new edit').click();true`);
  await waitFor(`document.getElementById('team-task-title')?.textContent.includes('Original task ${width}')&&document.getElementById('team-task-title')?.textContent.includes('edited, v3')`,'restore adds v3');
  const after=await api('GET',`/api/board/${board}/tasks/${id}/history`);assert.equal(after.body.length,3);assert.equal(after.body[1].snapshot.title,'Edited task '+width);
  assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no phone/page overflow');
  await shot(`${width}-restored-v3`);
  await click('Edit');await waitFor(`!!document.getElementById('task-edit-body')`,'combined text edit form');
  await ev(`document.getElementById('task-edit-title').value='Combined task ${width}';document.getElementById('task-edit-body').value='Description changed with the title';document.getElementById('task-edit-reason').value='Release regression check';true`);await click('Save');
  await waitFor(`document.getElementById('team-task-title')?.textContent.includes('Combined task ${width}')&&document.getElementById('team-task-title')?.textContent.includes('edited, v5')`,'body amendment and title edit use the successive current version');
  const combined=await api('GET',`/api/board/${board}/tasks/${id}`);assert.equal(combined.body.body,'Description changed with the title');
  await shot(`${width}-combined-v5`);
  const amendment=await api('PATCH',`/api/board/${board}/tasks/${id}/amend`,{subscriber_id:'Operator',base_revision:combined.body.revision,reason:'Instruction version check',changes:{workflow_instructions:'Follow versioned fixture instructions.'}});assert.equal(amendment.status,200,JSON.stringify(amendment));assert.equal(amendment.body.version,6);
  const restored=await api('PATCH',`/api/board/${board}/tasks/${id}`,{subscriber_id:'Operator',restore_version:5,base_version:6});assert.equal(restored.status,200);assert.equal(restored.body.version,7);assert.ok(!restored.body.workflow.effective_instructions.includes('Follow versioned fixture instructions.'));
  const all=await api('GET',`/api/board/${board}/tasks/${id}/history`);assert.ok(all.body[5].snapshot.instructions.includes('Follow versioned fixture instructions.'));assert.ok(!all.body[6].snapshot.instructions.includes('Follow versioned fixture instructions.'));
  console.log(`PASS ${width}: edit v2, immutable history/diff, restore as v3`);
  console.log(`PASS ${width}: combined description/title save keeps both versioned changes`);
 }
 } finally {await removeBoards(ev,[board]);await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
