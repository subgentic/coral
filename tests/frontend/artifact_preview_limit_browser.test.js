// #17210: real viewer/sandbox; generated HTML bytes, real saved preview setting.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const {guardSettings}=require('./helpers/settings_guard');
(async()=>{
 const guard=await guardSettings();
 const timings={};
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const S=`(window.__coralStatic || '/static/')`, hex='d'.repeat(64);
 const shot=require('./helpers/scene_shots')(Page);
 try {
  await Page.enable(); await client.Target.setDiscoverTargets({discover:true}); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE}); await Page.loadEventFired(); await install();
  await require('./helpers/wait').coralReady(ev);
  await ev(`(() => { const real=window.fetch.bind(window); window.fetch=(u,o)=>new URL(String(u),location.href).pathname==='/api/artifacts/${hex}' ? Promise.resolve(new Response(window.__html,{headers:{'Content-Type':window.__mediaType||'text/html','Content-Length':String(new TextEncoder().encode(window.__html).length)}})) : real(u,o); })()`);
  const open=async (mb, markdown=false)=>{
   await ev(`(async()=>{ document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); window.__mediaType=${markdown}?'text/markdown':'text/html'; window.__html=(${markdown}?'# Large markdown ready\\n\\n<!--':'<!doctype html><h1>Large artifact ready</h1><p>A readable HTML report.</p><!--')+'x'.repeat(Math.floor(${mb}*1024*1024)-100)+'-->'; window.__openedAt=performance.now(); window.__longTasks=[]; window.__paintObserver?.disconnect(); window.__paintObserver=new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>e.duration))); window.__paintObserver.observe({type:'longtask'}); const v=await import(${S}+'artifact_viewer.js'); await v.openArtifactViewer('${hex}',{filename:${markdown}?'large-report.md':'large-report.html',mediaType:window.__mediaType,sourceNamed:false});return true;})()`);
  };
  await open(3.1);
  await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe') || document.querySelector('#artifact-viewer .inline-preview-artifact-fallback')?.textContent.includes('Preview is limited to')`,'preview or size fallback',15000);
  await shot('artifact-limit-before-or-default');
  await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`,'3.1 MB default HTML preview',15000);
  await shot('artifact-limit-default');
  // The actual sandbox is opaque. Read first paint through CDP, never weaken it.
  const paint=async()=>{
   // A DOM nodeId is invalidated when the replacement iframe becomes an OOPIF.
   // A Runtime object handle remains stable across that debugger-tree update.
   const frameObject=await client.Runtime.evaluate({expression: "document.querySelector('#artifact-viewer .artifact-linked-preview iframe')",returnByValue:false});
   const {node}=await client.DOM.describeNode({objectId:frameObject.result.objectId});
   await client.Runtime.releaseObject({objectId:frameObject.result.objectId});
   assert.ok(node.frameId,'preview iframe has a frame id');
   // Replacing a preview creates its opaque-origin target asynchronously. Match its
   // frame id so an old preview cannot supply the next file's paint measurement.
   const target=await new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);client.removeListener('Target.targetCreated',found);client.removeListener('Target.targetInfoChanged',found);};
    const found=({targetInfo})=>{if(targetInfo.targetId===node.frameId&&targetInfo.url==='about:srcdoc'){cleanup();resolve(targetInfo);}};
    client.on('Target.targetCreated',found);client.on('Target.targetInfoChanged',found);
    timer=setTimeout(()=>{cleanup();reject(Error('preview sandbox target did not become ready'));},15000);
    client.Target.getTargets().then(({targetInfos})=>targetInfos.forEach(targetInfo=>found({targetInfo})),error=>{cleanup();reject(error);});
   });
   const {sessionId}=await client.Target.attachToTarget({targetId:target.targetId,flatten:true});
   try {await client.send('Page.enable',{},sessionId); const tree=await client.send('Page.getFrameTree',{},sessionId);
    const {executionContextId}=await client.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'preview-measure'},sessionId);
    const result=await client.send('Runtime.evaluate',{contextId:executionContextId,awaitPromise:true,returnByValue:true,expression:`new Promise(async(resolve,reject)=>{if(document.readyState==='loading')await new Promise(r=>document.addEventListener('DOMContentLoaded',r,{once:true}));if(!document.body.textContent.includes('Large artifact ready'))return reject(Error('wrong preview'));const p=performance.getEntriesByName('first-contentful-paint')[0];if(p)return resolve(p.startTime);const obs=new PerformanceObserver(list=>{const p=list.getEntries().find(e=>e.name==='first-contentful-paint');if(p){obs.disconnect();resolve(p.startTime)}});obs.observe({type:'paint',buffered:true});setTimeout(()=>reject(Error('first paint missing')),15000)})`},sessionId);
    assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;
   } finally {await client.Target.detachFromTarget({sessionId}).catch(()=>{});}
  };
  timings['3.1MB']={firstContentfulPaintMs:await paint(),...await ev('({openToPreviewMs:performance.now()-window.__openedAt,longTasksMs:window.__longTasks})')};
  console.log('3.1 MB timing:',timings['3.1MB']);
  await open(16);
  await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`,'16 MB default HTML preview',15000);
  timings['16MB']={firstContentfulPaintMs:await paint(),...await ev('({openToPreviewMs:performance.now()-window.__openedAt,longTasksMs:window.__longTasks})')};
  console.log('16 MB timing:',timings['16MB']);
  await shot('artifact-limit-16mb');
  await open(3.1,true);
  await waitFor(`document.querySelector('#artifact-viewer .prose h1')?.textContent==='Large markdown ready'`,'3.1 MB Markdown preview',15000);
  await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
  await ev(`window.showSettingsModal('files').then(()=>true)`);
  assert.equal(await ev(`document.getElementById('settings-artifact-preview-max-mb').value`),'16');
  await shot('artifact-limit-setting');
  await ev(`(() => { const e=document.getElementById('settings-artifact-preview-max-mb'); e.value='2'; e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await waitFor(`document.getElementById('settings-artifact-preview-max-mb').closest('.sv-row').querySelector('.settings-save-status')?.textContent==='Saved'`,'preview setting saved',10000);
  assert.equal(await ev(`fetch('/api/settings').then(r=>r.json()).then(d=>d.settings.artifact_preview_max_mb)`),'2');
  await ev(`document.querySelector('#settings-modal .modal-close, #settings-modal [data-close]')?.click(); true`);
  await open(3.1);
  await waitFor(`document.querySelector('#artifact-viewer .inline-preview-artifact-fallback')?.textContent.includes('Settings > Files and Git > Largest artifact to preview')`,'2 MB fallback names setting',10000);
  assert.match(await ev(`document.querySelector('#artifact-viewer').textContent`),/Preview is limited to 2(?:\.0)? MB/);
  await shot('artifact-limit-2mb');
  if(process.env.CORAL_SCREENSHOT_DIR)require('node:fs').writeFileSync(require('node:path').join(process.env.CORAL_SCREENSHOT_DIR,'timings.json'),JSON.stringify(timings,null,2));
  console.log('PASS default 3.1/16 MB preview and saved 2 MB fallback');
 } finally {await guard.restore();await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
