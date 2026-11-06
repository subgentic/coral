// #13771: an internal file opens in front of a native question and returns to
// that exact draft. Real CDP hit-testing and keyboard focus; no native webview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const HEX = 'c'.repeat(64), NEXT = 'd'.repeat(64);
const nativePolicy = fs.readFileSync(require('node:path').join(__dirname,'../../coral-go/cmd/coral-app/links.go'),'utf8').match(/const linkInterceptScript = `([\s\S]*?)`/)[1];
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const failures = []; const BOARD = 'ql-' + Date.now().toString(36);
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const width of [1280,390,320]) for (const server of ['', 'other-computer']) {
   const at = `${width}/${server || 'local'}`;
   await Emulation.setDeviceMetricsOverride({ width, height:900, deviceScaleFactor:1, mobile:width<768 });
   await Emulation.setTouchEmulationEnabled({ enabled:width<768 });
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
   if(width===1280&&!server)await ev(`fetch('/api/board/'+${JSON.stringify(BOARD)}+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Operator',job_title:'Operator'})}).then(r=>r.status)`);
   await ev(`(() => { const original = window.fetch; window.__linkReads = []; window.fetch = (u,o) => { const s=String(u); if(s.includes('/api/artifacts/${HEX}/comments')) return Promise.resolve(new Response(JSON.stringify({comments:[{id:1,parent_id:null,anchor:{whole:true},body:'Read coral://artifacts/${NEXT}',author:{kind:'owner',issuer:'local',subject:'Operator'},created_at:new Date().toISOString()}],you:{can_comment:false}}),{headers:{'Content-Type':'application/json'}})); if(s.includes('/api/artifacts/${NEXT}')) {window.__linkReads.push(s);return Promise.resolve(new Response(s.includes('/comments')?JSON.stringify({comments:[],you:{can_comment:false}}):'# Nested comment file',{headers:{'Content-Type':s.includes('/comments')?'application/json':'text/markdown'}}));} if(s.includes('/api/artifacts/${HEX}')) { window.__linkReads.push(s); return Promise.resolve(new Response('# Visible internal file\\n\\nQuestion link preview.', {headers:{'Content-Type':'text/markdown','Content-Disposition':'attachment; filename="question.md"'}})); } return original(u,o); }; return true; })()`);
   await ev(`import((window.__coralStatic||'/static/')+'operator_ask_dialog.js').then(m => m.openAskDialog({kind:'ask',id:73,board:${JSON.stringify(BOARD)},asker:'Writer',server:${JSON.stringify(server)},text:'@Operator Read coral://artifacts/${HEX} before answering.',at:new Date().toISOString()})); true`);
   await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog a.mb-artifact-ref')`,at+': file link',10000);
   if(width===1280&&!server){
    await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog input[type=file]')`,'draft image picker',6000);
    await ev(`(async()=>{const c=document.createElement('canvas');c.width=8;c.height=8;c.getContext('2d').fillRect(0,0,8,8);const blob=await new Promise(r=>c.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File([blob],'draft.png',{type:'image/png'}));const input=document.querySelector('dialog.inbox-ask-dialog input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog .ac-thumb-ready img')`,'real draft image stored',10000);
    await ev(`window.__draftImage=document.querySelector('dialog.inbox-ask-dialog .ac-thumb-ready img').src;true`);
   }
   await ev(`(() => { const d=document.querySelector('dialog.inbox-ask-dialog');window.__originalQuestion=d;d.querySelector('textarea').value='Keep this draft unchanged.';const a=d.querySelector('a.mb-artifact-ref');a.focus();a.click();return true;})()`);
   await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent.includes('Question link preview.')`,at+': file loaded',10000);
   const state=await ev(`(() => {const v=document.querySelector('#artifact-viewer'),b=v.querySelector('.artifact-viewer-close'),r=b.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {questionOpen:window.__originalQuestion.open,questionVisible:window.__originalQuestion.getClientRects().length>0,focus:v.contains(document.activeElement),front:!!top&&v.contains(top),reads:window.__linkReads};})()`);
   if(state.questionOpen||state.questionVisible||!state.focus||!state.front)failures.push(at+': viewer must be usable in front '+JSON.stringify(state));
   if(server&&!state.reads.some(u=>u.includes('/api/remote/'+server+'/api/artifacts/')))failures.push(at+': lost remote computer '+JSON.stringify(state.reads));
   if(server&&width===1280){
    await waitFor(`document.querySelector('#artifact-viewer .ac-toggle')&&!document.querySelector('#artifact-viewer .ac-toggle').hidden`,'comment panel available',6000);
    await ev(`document.querySelector('#artifact-viewer .ac-toggle').click();true`);
    await waitFor(`!!document.querySelector('#artifact-viewer .ac-body a.mb-artifact-ref')`,'comment file link',6000);
    await ev(`document.querySelector('#artifact-viewer .ac-body a.mb-artifact-ref').click();true`);
    await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent.includes('Nested comment file')`,'comment file opens internally',6000);
    assert.ok(await ev(`window.__linkReads.some(u=>u.includes('/api/remote/other-computer/api/artifacts/${NEXT}'))`),'comment link keeps its source computer');
   }
   if(!server&&[390,1280].includes(width)&&process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/question-file-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click();true`);
   await waitFor(`window.__originalQuestion.open`,at+': question returns',6000);
   assert.ok(await ev(`window.__originalQuestion===document.querySelector('dialog.inbox-ask-dialog')&&window.__originalQuestion.querySelector('textarea').value==='Keep this draft unchanged.'`),at+': same draft DOM retained');
   assert.ok(await ev(`window.__originalQuestion.contains(document.activeElement)`),at+': focus returns inside the question');
   if(width===1280&&!server)assert.ok(await ev(`window.__originalQuestion.querySelector('.ac-thumb-ready img')?.src===window.__draftImage`),'the uploaded draft picture survives viewer open/close');
   await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn').click();true`);
  }
  await Page.addScriptToEvaluateOnNewDocument({source: `window.__CORAL_APP__=true;window.__nativeExternal=[];window._coralOpenExternal=u=>window.__nativeExternal.push(u);`+nativePolicy});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await Emulation.setDeviceMetricsOverride({width:390,height:900,deviceScaleFactor:1,mobile:true});
  const api=async(path,body)=>ev(`fetch(${JSON.stringify(path)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json()}))`);
  assert.ok((await api('/api/board/'+BOARD+'/subscribe',{subscriber_id:'Operator',job_title:'Operator'})).status<300);
  const goal=await api('/api/board/'+BOARD+'/goals',{subscriber_id:'Operator',title:'Linked goal',outcome:'Read the goal',done_when:'read'});
  const task=await api('/api/board/'+BOARD+'/tasks',{subscriber_id:'Operator',created_by:'Operator',assigned_to:'Operator',title:'Linked task',body:'Read the task'});
  assert.equal(goal.status,201);assert.ok(task.status<300);
  const openQuestion=async text=>{await ev(`import((window.__coralStatic||'/static/')+'operator_ask_dialog.js').then(m=>m.openAskDialog({kind:'ask',id:74,board:${JSON.stringify(BOARD)},asker:'Writer',goal_id:${goal.data.id},task_id:${task.data.id||task.data.task?.id},text:${JSON.stringify(text)},at:new Date().toISOString()}));true`);await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`,'question open',6000);await ev(`window.__originalQuestion=document.querySelector('dialog.inbox-ask-dialog');window.__originalQuestion.querySelector('textarea').value='Keep the navigation draft.';true`);};
  for(const kind of ['goal','task','uri']) {
   await openQuestion('@Operator Read coral://goals/'+BOARD+'/'+goal.data.id+' before answering.');
   const selector=kind==='uri'?'a.coral-subject-ref':'.inbox-ask-subject[data-kind="'+kind+'"]';
   await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog '+${JSON.stringify(selector)})`,'subject link ready',6000);
   await ev(`(()=>{const a=document.querySelector('dialog.inbox-ask-dialog '+${JSON.stringify(selector)});a.focus();a.click();return true;})()`);
   await waitFor(`!window.__originalQuestion.open && ${kind==='task'?"document.querySelector('#inbox-page .team-task-page')?.textContent.includes('Linked task')":"document.querySelector('#goals-detail-title')?.textContent==='Linked goal'"}`,'real About/'+kind+' page in front',12000);
   await ev(`history.back();true`);await waitFor(`window.__originalQuestion.open`,'Back restores the question',10000);
   assert.equal(await ev(`window.__originalQuestion.querySelector('textarea').value`),'Keep the navigation draft.');
   await ev(`window.__originalQuestion.querySelector('.inbox-ask-buttons .btn').click();true`);
  }
  // Diff references resolve a hash against the declared team's exact session list.
  const diffHash=await ev(`(async()=>{const sum=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('src/example.js'));return [...new Uint8Array(sum).slice(0,8)].map(b=>b.toString(16).padStart(2,'0')).join('');})()`);
  await ev(`(()=>{window.__m.add('diff-agent','D',2,{sleeping:false,session_id:'diff-abc123',board_project:${JSON.stringify(BOARD)}});const original=window.fetch;window.fetch=(u,o)=>{const p=new URL(String(u),location.origin).pathname,json=b=>Promise.resolve(new Response(JSON.stringify(b),{headers:{'Content-Type':'application/json'}}));if(p==='/api/sessions/live/diff-agent/files')return json({files:[{filepath:'src/example.js',status:'M'}],is_git:true});if(p==='/api/sessions/live/diff-agent/file-content')return json({content:'const answer = 2;'});if(p==='/api/sessions/live/diff-agent/file-original')return json({content:'const answer = 1;'});return original(u,o);};return true;})()`);
  await openQuestion('@Operator Read coral://diffs/'+BOARD+'/diff-abc123/'+diffHash+' before answering.');
  await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog a.coral-subject-ref')`,'diff link ready',6000);
  await ev(`document.querySelector('dialog.inbox-ask-dialog a.coral-subject-ref').click();true`);
  await waitFor(`!window.__originalQuestion.open&&document.querySelector('#preview-pane .cm-editor')?.textContent.includes('answer')`,'diff preview in front',15000);
  await ev(`document.querySelector('#preview-full-back').click();true`);
  await waitFor(`window.__originalQuestion.open`,'phone diff Back restores question',10000);
  assert.equal(await ev(`window.__originalQuestion.querySelector('textarea').value`),'Keep the navigation draft.');
  await ev(`window.__originalQuestion.querySelector('.inbox-ask-buttons .btn').click();true`);
  await ev(`(()=>{window.__m.agents['diff-abc123'].msgs.push({type:'assistant',text:'[Open chat file](coral://artifacts/${HEX})'});const original=window.fetch;window.fetch=(u,o)=>String(u).includes('/api/artifacts/${HEX}')?Promise.resolve(new Response('# Chat file preview',{headers:{'Content-Type':'text/markdown'}})):original(u,o);return true;})()`);
  await ev(`window.selectLiveSession('diff-agent','claude','diff-abc123','local').then(()=>true)`);
  await waitFor(`!!document.querySelector('#live-history-messages [data-file-ref="coral://artifacts/${HEX}"]')`,'chat uses its file-reference renderer',10000);
  await ev(`document.querySelector('#live-history-messages [data-file-ref="coral://artifacts/${HEX}"]').click();true`);
  await waitFor(`!!document.querySelector('.chat-file-menu [data-action="preview"]')`,'chat preview menu',6000);
  await ev(`document.querySelector('.chat-file-menu [data-action="preview"]').click();true`);
  await waitFor(`document.querySelector('#preview-pane')?.textContent.includes('Chat file preview')`,'chat file stays inside Coral',10000);
  await openQuestion('@Operator Read coral://artifacts/'+HEX+' inside the native capture policy.');
  await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog a.mb-artifact-ref')`,'native question artifact link',6000);
  await ev(`document.querySelector('dialog.inbox-ask-dialog a.mb-artifact-ref').click();true`);
  await waitFor(`!window.__originalQuestion.open&&document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent.includes('Chat file preview')`,'native question file stays inside app',10000);
  await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click();true`);
  await waitFor(`window.__originalQuestion.open`,'native question draft returns',6000);
  assert.deepEqual(await ev('window.__nativeExternal'),[],'internal goal/diff/chat links never request the system browser');
  await ev(`(()=>{const a=document.createElement('a');a.href='https://example.invalid/external';a.target='_blank';window.__originalQuestion.append(a);a.click();a.remove();return true;})()`);
  assert.deepEqual(await ev('window.__nativeExternal'),['https://example.invalid/external'],'external https keeps its system-browser policy');
  assert.deepEqual(failures,[]);
 }finally{await removeBoards(ev,[BOARD]).catch(()=>{});await client.close();}
 console.log('PASS artifact_question_links_browser');
})().catch(e=>{console.error(e);process.exit(1);});
