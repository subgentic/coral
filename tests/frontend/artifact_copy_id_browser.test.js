// Copy the exact immutable version, from local/remote review row actions and the viewer.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {connect}=require('./agent_view_harness');
const {coralReady,waitStable}=require('./helpers/wait');
const {H1,H2,H3,STUB}=require('./helpers/artifact_versions_stub');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();let original;
 const shot=async name=>{if(!process.env.CORAL_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR,name+'.png'),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 const click=async selector=>{
  await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))e.scrollIntoView({block:'nearest',inline:'nearest'});})()`);
  await waitStable(ev,`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,disabled:!!e.disabled};})()`,'stable enabled '+selector,40,{timeout:5000,accept:r=>!r.disabled&&r.w>0&&r.h>0});
  const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered '+${JSON.stringify(selector)});return{x,y};})()`);
  await client.Input.dispatchMouseEvent({type:'mousePressed',...p,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',...p,button:'left',clickCount:1});
 };
 const dismissCopied=async()=>{
  await waitFor(`!![...document.querySelectorAll('#toast-host .toast')].find(t=>t.querySelector('.toast-message')?.textContent==='Artifact ID copied')`,'copy success notice');
  await ev(`[...document.querySelectorAll('#toast-host .toast')].find(t=>t.querySelector('.toast-message')?.textContent==='Artifact ID copied').classList.add('copy-toast');true`);
  await click('.copy-toast .toast-close');await waitFor(`!document.querySelector('.copy-toast')`,'success notice dismissed');
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});await Emulation.setFocusEmulationEnabled({enabled:true});
  await client.Browser.grantPermissions({origin:new URL(BASE).origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);original=await ev('navigator.clipboard.readText()');await ev(STUB);
  for(const [server,hex] of [['local',H1],['m1',H2]]){
   await ev(`(async()=>{const {reviewActions}=await import((window.__coralStatic||'/static/')+'inbox_sidebar.js');document.getElementById('copy-row')?.remove();const row=document.createElement('div');row.id='copy-row';row.style.cssText='position:fixed;top:160px;left:50px;z-index:10000;background:var(--bg-primary);padding:12px';row.append(reviewActions({id:'${hex}',name:'release-plan.md',uri:'coral://artifacts/${H3}',team:'${server==='local'?'copy-team':'@m1/copy-team'}',tags:['for review'],version:${hex===H1?1:2}}));document.body.append(row);})()`);
   await click('#copy-row .inbox-row-more-toggle');await waitFor(`!!document.querySelector('#copy-row .menu:not([hidden])')`,'row More menu');
   await shot('row-'+server);assert.ok(await ev(`!![...document.querySelectorAll('#copy-row [role=menuitem]')].find(b=>b.textContent==='Copy version ID')`),server+' row offers Copy version ID');
   await ev(`document.querySelectorAll('#copy-row [role=menuitem]').forEach(b=>{if(b.textContent==='Copy version ID')b.classList.add('copy-id-target')});true`);await click('#copy-row .copy-id-target');
   await waitFor(`navigator.clipboard.readText().then(t=>t==='coral://artifacts/${hex}')`,server+' row own-version clipboard');assert.equal(await ev('navigator.clipboard.readText()'),'coral://artifacts/'+hex);await dismissCopied();
  }
  await ev(`document.getElementById('copy-row').remove();true`);
  await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers=[...(state.servers||[]).filter(s=>s&&s.id!=='m1'),{id:'m1',label:'m1'}];state.serversKnown=true;return true;})`); // the viewer opens a file only on a computer the page lists (#13949)
 for(const [server,hex] of [['local',H1],['m1',H3]]){
   await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(v=>v.openArtifactViewer('${hex}',{server:'${server}',board:'copy-team',filename:'release-plan.md',mediaType:'text/markdown'}))`);
   await waitFor(`!!document.querySelector('.artifact-viewer-markdown')`,'rendered requested version');await click('.artifact-viewer-more');await waitFor(`!document.querySelector('.artifact-viewer-menu').hidden`,'viewer More menu');
   await shot('viewer-'+server);assert.ok(await ev(`!!document.querySelector('.artifact-viewer-copy-id')`),'viewer offers same action');await click('.artifact-viewer-copy-id');await waitFor(`navigator.clipboard.readText().then(t=>t==='coral://artifacts/${hex}')`,'viewer current-version clipboard');await dismissCopied();await click('.artifact-viewer-close');
  }
  console.log('PASS native clipboard: local/remote review row own digest and viewer current version, including reused viewer');
 }finally{if(original!==undefined)await ev(`navigator.clipboard.writeText(${JSON.stringify(original)})`).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exit(1)});
