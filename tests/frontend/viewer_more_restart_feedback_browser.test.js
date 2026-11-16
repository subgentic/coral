// #17021: viewer More reaches Download by a real click; restart feedback does not show pending and done together.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady, nextFrame, waitStable } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect(),problems=[];
 const S=`(window.__coralStatic||'/static/')`;
 const press=async(selector,touch=false)=>{
  await waitStable(ev,`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null})()`,'stable action',40,{timeout:5000,accept:r=>r&&r.w>0&&r.h>0});
  const p=await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`);assert.ok(p.hit,'pointer reaches '+selector);
  if(touch){await client.Input.dispatchTouchEvent({type:'touchStart',touchPoints:[{x:p.x,y:p.y,id:1}]});await client.Input.dispatchTouchEvent({type:'touchEnd',touchPoints:[]});}
  else for(const type of ['mouseMoved','mousePressed','mouseReleased'])await client.Input.dispatchMouseEvent({type,x:p.x,y:p.y,button:type==='mouseMoved'?'none':'left',buttons:type==='mousePressed'?1:0,clickCount:type==='mouseMoved'?0:1});
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const [width,height,mobile] of [[1280,900,false],[390,844,true]]){
   await Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile});await Emulation.setTouchEmulationEnabled({enabled:mobile});
   await Page.navigate({url:BASE+'/agents'});await Page.loadEventFired();await install();await coralReady(ev);await ev(STUB);
   await ev(`document.documentElement.dataset.theme='light';window.__downloadHits=0;document.addEventListener('click',e=>{if(e.target.closest('.artifact-viewer-download')){e.preventDefault();e.stopImmediatePropagation();window.__downloadHits++}},true);true`);
   await ev(`import(${S}+'artifact_viewer.js').then(m=>m.openArtifactViewer('${H3}',{filename:'release-plan.md',server:'local',board:'team-a'}))`);
   await waitFor(`!!document.querySelector('.artifact-viewer-markdown')&&!!document.querySelector('.artifact-viewer-download')?.getAttribute('href')`,'viewer and Download link ready');
   for(let attempt=0;attempt<4;attempt++){
    await press('.artifact-viewer-more',mobile);
    await waitFor(`document.querySelector('.artifact-viewer-more').getAttribute('aria-expanded')==='true'&&!document.querySelector('.artifact-viewer-menu').hidden`,'More opens and stays open');await nextFrame(ev);
    assert.equal(await ev(`document.querySelector('.artifact-viewer-more').getAttribute('aria-expanded')`),'true');
    await press('.artifact-viewer-download',mobile);assert.equal(await ev('window.__downloadHits'),attempt+1,'Download receives a real pointer activation');
    await ev(`import(${S}+'menu_button.js').then(m=>{m.closeMenus();return true})`);
   }
   await press('.artifact-viewer-close',mobile);
   // A quick, entirely mocked restart makes the old in-flight toast overlap the completion toast.
   await ev(`(()=>{const m=window.__m;for(const id of Object.keys(m.agents))delete m.agents[id];m.add('restart-feedback','O',3,{sleeping:false,session_id:'feedback-old',display_name:'Writer'});T.state.liveSessions=Object.values(m.agents).map(a=>m.entry(a));T.render.renderLiveSessions(T.state.liveSessions);const real=window.fetch;window.fetch=(url,opts={})=>{const u=String(url);if(/\\/api\\/sessions\\/live\\/[^/?]+\\/restart$/.test(u)&&opts.method==='POST'){const old=m.agents['feedback-old'];delete m.agents['feedback-old'];const qa=window.__qaState;window.__qaState=null;m.add(old.name,'N',2,{sleeping:false,session_id:'feedback-new',display_name:'Writer'});window.__qaState=qa;T.ws.handleCoralMessage({type:'coral_diff',changed:[m.entry(m.agents['feedback-new'])],removed:['feedback-old']});return Promise.resolve(Response.json({ok:true,session_id:'feedback-new',session_name:old.name,agent_name:old.name}))}if(/\\/api\\/sessions\\/live\\/[^/?]+\\?session_id=/.test(u))return Promise.resolve(Response.json({ok:true}));return real(url,opts)};for(const b of document.querySelectorAll('#toast-host .toast-close'))b.click();return true})()`);
   await ev(`window.selectLiveSession('restart-feedback','claude','feedback-old','local')`);
   await ev(`import(${S}+'restart_flow.js').then(m=>m.restartSameSettings()).then(()=>true)`);
   await waitFor(`[...document.querySelectorAll('#toast-host .toast-message')].some(n=>n.textContent==='Writer restarted')`,'restart completion feedback');
   const notices=await ev(`[...document.querySelectorAll('#toast-host .toast-message')].map(n=>n.textContent)`);
   if(notices.some(t=>/^Restarting\b/.test(t)))problems.push(width+': stale pending toast beside completion: '+JSON.stringify(notices));
  }
  // Overlapping restarts retain progress for the other request; error notices survive cleanup.
  await ev(`(()=>{const m=window.__m;for(const [id,name] of [['batch-a','Worker A'],['batch-b','Worker B']])m.add(id,'B',1,{sleeping:false,session_id:id,display_name:name});T.state.liveSessions=Object.values(m.agents).map(a=>m.entry(a));T.render.renderLiveSessions(T.state.liveSessions);for(const b of document.querySelectorAll('#toast-host .toast-close'))b.click();window.__pendingRestart={};const real=window.fetch;window.fetch=(url,opts={})=>{if(/\\/api\\/sessions\\/live\\/[^/?]+\\/restart$/.test(String(url))&&opts.method==='POST'){const id=JSON.parse(opts.body).session_id;return new Promise(resolve=>{window.__pendingRestart[id]=()=>resolve(Response.json({error:'Cannot restart '+id}))})}return real(url,opts)};return true})()`);
  for(const [id,key] of [['batch-a','__runA'],['batch-b','__runB']]){
   await ev(`window.selectLiveSession('${id}','claude','${id}','local')`);
   await ev(`import(${S}+'restart_flow.js').then(m=>{window.${key}=m.restartSameSettings();return true})`);
   await waitFor(`typeof window.__pendingRestart['${id}']==='function'`,'restart held in flight');
  }
  assert.deepEqual(await ev(`[...document.querySelectorAll('#toast-host .toast[data-group="restarting"] .toast-message')].map(n=>n.textContent)`),['Restarting 2 agents'],'overlapping requests share one progress card');
  await ev(`(async()=>{window.__pendingRestart['batch-a']();await window.__runA;return true})()`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('#toast-host .toast[data-group="restarting"] .toast-message')].map(n=>n.textContent)`),['Restarting Worker B'],'finishing one request preserves only the other progress');
  await ev(`(async()=>{window.__pendingRestart['batch-b']();await window.__runB;return true})()`);
  assert.equal(await ev(`document.querySelectorAll('#toast-host .toast[data-group="restarting"]').length`),0,'no progress remains after both requests finish');
  const errors=await ev(`[...document.querySelectorAll('#toast-host .toast.error .toast-message')].map(n=>n.textContent)`);
  assert.ok(errors.includes('Cannot restart batch-a')&&errors.includes('Cannot restart batch-b'),'progress cleanup retains both failure notices');
  assert.deepEqual(problems,[]);console.log('PASS viewer More/Download pointer access and nonconflicting restart feedback at 1280/390');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1)});
