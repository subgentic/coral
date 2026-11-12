// #14092: Chief has its own way back in a native window without browser chrome.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const {guardSettings}=require('./helpers/settings_guard');
const {removeBoards}=require('./helpers/board_cleanup');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const guard=await guardSettings();let board='chief-back-'+Date.now().toString(36),sid,name;
 const api=(method,path,body)=>ev(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`);
 const shot=async label=>{if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/'+label+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}};
 const dashboard=async()=>{await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});await dashboard();
  const launch=await api('POST','/api/sessions/launch',{working_dir:os.tmpdir(),agent_type:'terminal',display_name:'Chief',board_name:board,new_board:true});board=launch.body.board_id||board;sid=launch.body.session_id;name=launch.body.session_name||launch.body.name;assert.ok(sid);
  assert.equal((await api('POST',`/api/board/${board}/subscribe`,{subscriber_id:'Chief',job_title:'Chief',session_name:name})).status,200);
  assert.equal((await api('PUT','/api/settings',{chief_page:'true',chief_session:sid,chief_team:board,chief_name:'Chief'})).status,200);
  await dashboard();await ev(`window.showSettingsModal('chief');true`);await waitFor(`!!document.querySelector('a.chief-open-link[href="/chief"]:not([hidden])')`,'Open Chief in Settings > Chief');
  await ev(`document.querySelector('a.chief-open-link').click();true`);await waitFor(`location.pathname==='/chief'&&document.body?.dataset.chief==='true'`,'Chief opens as its page');
  await waitFor(`document.body?.classList.contains('popout-mode')&&document.querySelector('.terminal-header')?.getBoundingClientRect().height>0&&document.getElementById('terminal-header-label')?.textContent==='Chief'`,'Chief header settled');
  await shot('chief-before-or-after-desktop');
  await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});
  await shot('chief-phone-entry');
  await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
  console.log('Chief entry diagnostic',await ev(`fetch('/api/chief').then(r=>r.json())`));
  await waitFor(`document.querySelector('[data-chief-back]')?.getBoundingClientRect().height>=44`,'visible 44px Back to Coral');
  await shot('chief-desktop-ready');
  const back=await ev(`(()=>{const e=document.querySelector('[data-chief-back]'),r=e.getBoundingClientRect();return{text:e.textContent.trim(),w:r.width,h:r.height,x:r.left};})()`);
  assert.equal(back.text,'Back to Coral');assert.ok(back.w>=44&&back.h>=44&&back.x<200,JSON.stringify(back));
  await ev(`document.querySelector('[data-chief-back]').click();true`);await waitFor(`location.pathname!=='/chief'&&document.body&&!document.body.dataset.chief?.includes('true')`,'control returns to dashboard');
  const nativeMarker=await Page.addScriptToEvaluateOnNewDocument({source:'window.__CORAL_APP__=true;'});
  // #14165: capture navigation must leave the focused control its own Escape.
  await Page.navigate({url:BASE+'/chief'});await Page.loadEventFired();await coralReady(ev,'startup');
  await waitFor(`document.body?.classList.contains('popout-mode')&&!!document.querySelector('[data-chief-back]')`,'native Chief ready for guards');
  for(const setup of [
   `const el=document.createElement('textarea');el.value='Unsent Chief draft';document.body.append(el);el.focus()`,
   `const el=document.createElement('input');el.value='Unsent text';document.body.append(el);el.focus()`,
   `const el=document.createElement('div');el.contentEditable='true';el.textContent='Editor draft';document.body.append(el);el.focus()`,
   `document.activeElement?.blur()`,
   `const el=document.createElement('dialog');el.textContent='Open dialog';document.body.append(el);el.showModal()`,
   `const el=document.createElement('div');el.setAttribute('role','menu');el.textContent='Open menu';document.body.append(el)`,
   `const el=document.createElement('div');el.setAttribute('popover','manual');el.textContent='Open popup';document.body.append(el);el.showPopover()`
  ]){
   const composing=setup===`document.activeElement?.blur()`;
   const result=await ev(`(()=>{const before=new Set(document.body.children);${setup};const target=document.activeElement||document.body;let handled=false;const own=e=>{handled=true;e.preventDefault();e.stopImmediatePropagation()};target.addEventListener('keydown',own,{once:true});const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:${composing}});target.dispatchEvent(e);const draft=target.value||target.textContent;for(const node of document.body.children)if(!before.has(node))node.remove();return{handled,path:location.pathname,draft};})()`);
   assert.equal(result.handled,true,'focused control receives Escape: '+setup);
   assert.equal(result.path,'/chief','guard retains Chief: '+setup);
   if(setup.includes('Unsent Chief draft'))assert.equal(result.draft,'Unsent Chief draft');
  }
  for(const props of [{key:'[',metaKey:true,shiftKey:true},{key:'[',metaKey:true,altKey:true},{key:'[',metaKey:true,ctrlKey:true},{key:'['},{key:']',metaKey:true},{key:'Escape',shiftKey:true},{key:'Escape',repeat:true}]){
   assert.equal(await ev(`(()=>{document.activeElement?.blur();const e=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...${JSON.stringify(props)}});document.body.dispatchEvent(e);return e.defaultPrevented})()`),false,'wrong shortcut untouched '+JSON.stringify(props));
  }
  for(const key of ['Escape','[']){
   await Page.navigate({url:BASE+'/chief'});await Page.loadEventFired();
   await coralReady(ev,'startup');
   await waitFor(`!!document.querySelector('[data-chief-back]')&&document.body.classList.contains('popout-mode')`,'Chief back control');
   console.log('native key before',key,await ev(`({native:window.__CORAL_APP__,classes:document.body.className,modals:[...document.querySelectorAll('dialog[open], [aria-modal="true"]')].filter(e=>e.getClientRects().length).map(e=>({id:e.id,display:getComputedStyle(e).display,rect:e.getBoundingClientRect().toJSON()}))})`));
   await client.Input.dispatchKeyEvent({type:'keyDown',key,code:key==='Escape'?'Escape':'BracketLeft',modifiers:key==='['?4:0});
   await waitFor(`(location.pathname==='/'||location.pathname==='/agents')&&document.body?.dataset.entryMode!=='agent'`,'native keyboard returns to Coral '+key).catch(async e=>{throw new Error(e.message+' '+JSON.stringify(await ev(`({path:location.pathname,body:document.body?.innerText.slice(-500)})`)));});
  }
  await Page.removeScriptToEvaluateOnNewDocument({identifier:nativeMarker.identifier});
  await Page.navigate({url:BASE+'/chief'});await Page.loadEventFired();await coralReady(ev,'startup');
  assert.equal(await ev(`(()=>{const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(e);return e.defaultPrevented})()`),false,'web Escape is not Chief navigation');
  assert.equal(await ev(`location.pathname`),'/chief');
  const nonChiefMarker=await Page.addScriptToEvaluateOnNewDocument({source:'window.__CORAL_APP__=true;'});
  await dashboard();
  assert.equal(await ev(`(()=>{const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(e);return e.defaultPrevented})()`),false,'native dashboard Escape is not Chief navigation');
  await Page.removeScriptToEvaluateOnNewDocument({identifier:nonChiefMarker.identifier});
  await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});await Emulation.setTouchEmulationEnabled({enabled:true});
  await Page.navigate({url:BASE+'/chief'});await Page.loadEventFired();await waitFor(`document.querySelector('[data-chief-back]')?.getBoundingClientRect().height>=44`,'phone back control');
  assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`),true,'phone has no horizontal overflow');
  assert.equal(await ev(`document.querySelector('[data-chief-back]').getBoundingClientRect().height>=44`),true,'phone back target');
  await shot('chief-before-or-after-phone');
  console.log('PASS Chief sidebar entry, visible 44px return, native Escape/Cmd+[ and phone layout');
 }finally{
  if(sid)await api('POST',`/api/sessions/live/${encodeURIComponent(name)}/kill`,{agent_type:'terminal',session_id:sid}).catch(()=>{});
  await guard.restore();await removeBoards(ev,[board]).catch(()=>{});await client.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
