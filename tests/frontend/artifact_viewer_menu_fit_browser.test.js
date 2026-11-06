// Real viewer/menu layout at phone text sizes, with deterministic file/capability data.
// Pointer, keyboard and emulated touch each activate the same Edit action once.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {connect} = require('./agent_view_harness');
const {H3, STUB} = require('./helpers/artifact_versions_stub');
const {coralReady, waitStable, framesJs} = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const rect=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 const click=async selector=>{await waitStable(ev,`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};})()`,'stable '+selector,40,{timeout:5000,accept:r=>r.w>0&&r.h>0});const p=await rect(selector);assert.equal(await ev(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${p.x},${p.y}))`),true,'pointer hits '+selector);await client.Input.dispatchMouseEvent({type:'mousePressed',...p,button:'left',clickCount:1});await ev(framesJs(2));await client.Input.dispatchMouseEvent({type:'mouseReleased',...p,button:'left',clickCount:1});};
 const key=async(key,code,n)=>{await client.Input.dispatchKeyEvent({type:'keyDown',key,code,windowsVirtualKeyCode:n,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});await client.Input.dispatchKeyEvent({type:'keyUp',key,code,windowsVirtualKeyCode:n});};
 const tap=async selector=>{const p=await rect(selector);await client.Input.dispatchTouchEvent({type:'touchStart',touchPoints:[{...p,id:1}]});await client.Input.dispatchTouchEvent({type:'touchEnd',touchPoints:[]});};
 const shot=async name=>{if(!process.env.CORAL_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR,name+'.png'),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 const opened=()=>waitFor(`!document.querySelector('.artifact-viewer-menu').hidden`,'menu open',5000);
 const editing=()=>waitFor(`!!document.querySelector('.amd-text')`,'one activation opens editor',8000);
 const cancel=async()=>{await click('.amd-cancel');await waitFor(`!document.querySelector('.amd-editor')`,'unchanged editor cancelled',5000);};
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:390,height:900,deviceScaleFactor:1,mobile:true});await Emulation.setTouchEmulationEnabled({enabled:true});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await ev(STUB);
  await ev(`(()=>{const real=window.fetch;window.fetch=(u,o)=>/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/edit(?:\\?|$)/.test(String(u))?Promise.resolve(Response.json({can_edit:true})):real(u,o);return true;})()`);
  for(const [theme,font] of [['dark',32],['light',32],['dark',16],['light',16]]) {
   const label=theme+'-'+font;
   await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${font}px';import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(v=>v.openArtifactViewer('${H3}',{filename:'release-plan.md',server:'local',board:'team-a'}))`);
   await waitFor(`!!document.querySelector('.artifact-viewer-markdown')&&!document.querySelector('.artifact-viewer-edit').hidden&&!!document.querySelector('.av-current')`,'ready viewer header',10000);
   await click('.artifact-viewer-more');await opened();await ev(framesJs(2));
   const fit=await ev(`(()=>{const menu=document.querySelector('.artifact-viewer-menu'),box=document.querySelector('.artifact-viewer-content'),m=menu.getBoundingClientRect(),b=box.getBoundingClientRect();return{menu:{x:m.x,right:m.right,w:m.width},box:{x:b.x,right:b.right,w:b.width,client:box.clientWidth,scroll:box.scrollWidth,left:box.scrollLeft},viewport:innerWidth,anchor:menu.offsetParent?.className,translate:menu.style.translate,header:document.querySelector('.artifact-viewer-header').getBoundingClientRect().toJSON(),wrapPosition:getComputedStyle(document.querySelector('.artifact-viewer-morewrap')).position};})()`);
   console.log(label,JSON.stringify(fit));await shot('menu-'+label);
   assert.ok(fit.menu.w<=fit.viewport-16&&fit.menu.x>=0&&fit.menu.right<=fit.viewport,'menu border box fits phone: '+JSON.stringify(fit));
   assert.ok(fit.box.scroll<=fit.box.client+1,'open menu adds no sideways dialog overflow: '+JSON.stringify(fit));
   assert.ok(fit.menu.x>=fit.box.x-1&&fit.menu.right<=fit.box.right+1,'menu is not clipped by the dialog: '+JSON.stringify(fit));
   await click('.artifact-viewer-edit-item');await editing();await cancel();
   // Native keyboard opens the menu, moves between items and activates Edit.
   await ev(`document.querySelector('.artifact-viewer-more').focus({preventScroll:true});true`);await key('Enter','Enter',13);await opened();
   await key('ArrowDown','ArrowDown',40);if(!await ev(`document.activeElement.classList.contains('artifact-viewer-edit-item')`))await key('ArrowUp','ArrowUp',38);
   assert.equal(await ev(`document.activeElement.classList.contains('artifact-viewer-edit-item')`),true);await key('Enter','Enter',13);await editing();await cancel();
   // A finger nudge inside the document cannot pan an otherwise fitting dialog sideways.
   await tap('.artifact-viewer-more');await opened();const p=await ev(`(()=>{const r=document.querySelector('.artifact-viewer-body').getBoundingClientRect(),m=document.querySelector('.artifact-viewer-menu').getBoundingClientRect();return{x:r.x+r.width/2,y:Math.min(r.bottom-60,Math.max(r.y+60,m.bottom+60))};})()`);
   await client.Input.dispatchTouchEvent({type:'touchStart',touchPoints:[{...p,id:1}]});for(let n=1;n<=5;n++)await client.Input.dispatchTouchEvent({type:'touchMove',touchPoints:[{x:p.x+8*n,y:p.y,id:1}]});await client.Input.dispatchTouchEvent({type:'touchEnd',touchPoints:[]});await ev(framesJs(2));
   assert.equal(await ev(`document.querySelector('.artifact-viewer-content').scrollLeft`),0);assert.equal(await ev(`document.querySelector('.artifact-viewer-menu').hidden`),false,'horizontal finger nudge leaves fitting menu open');
   await tap('.artifact-viewer-edit-item');await editing();await cancel();
   // A real scroll of an ancestor still dismisses the menu, as before.
   await ev(`(()=>{const spacer=document.createElement('div');spacer.id='menu-test-scroll-space';spacer.style.height='200vh';document.body.append(spacer);window.__menuBodyMin=document.body.style.minHeight;document.body.style.minHeight='200vh';return true;})()`);await click('.artifact-viewer-more');await opened();await ev(`scrollTo(0,12);true`);
   await waitFor(`document.querySelector('.artifact-viewer-menu').hidden`,'actual ancestor scroll dismisses menu',5000);
   await ev(`document.querySelector('#menu-test-scroll-space').remove();document.body.style.minHeight=window.__menuBodyMin;scrollTo(0,0);true`);await click('.artifact-viewer-close');
   console.log('PASS pointer/keyboard/touch and ancestor-scroll dismissal '+label);
  }
 }finally{await client.close();}
})().catch(error=>{console.error(error);process.exit(1);});
