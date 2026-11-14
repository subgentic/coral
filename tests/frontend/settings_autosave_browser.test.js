// ST1a: row-scoped saves, durable values, rollback, accessible feedback and Close-only footer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const guard=await require('./helpers/settings_guard').guardSettings();
 const footerFailures=[];
 const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.addScriptToEvaluateOnNewDocument({source:`(() => { const real=window.fetch;window.__writes=[];window.__failSave=false;window.fetch=(u,o={})=>{if(new URL(String(u),location.origin).pathname==='/api/settings'&&o.method==='PUT'){window.__writes.push(JSON.parse(o.body));if(window.__refuseSave)return Promise.resolve(new Response(JSON.stringify({error:window.__refuseSave}),{status:400,headers:{'Content-Type':'application/json'}}));if(window.__failSave)return Promise.reject(new TypeError('Failed to fetch'));}return real(u,o);};})()`});
  for (const width of [1440,390]) for (const theme of ['dark','light']) for (const size of [16,32]) {
   await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
   await ev(`window.showSettingsModal('general')`);
   await waitFor(`document.getElementById('settings-modal')?.style.display==='flex'`,'Settings open');
   await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${size}px';true`);
   await ev(framesJs(2));
   if ((width===1440&&theme==='dark'&&size===16)||(width===390&&theme==='light'&&size===32)) await shot(`settings-autosave-${width}-${size}-${theme}`);
   // Capture evidence before assertions too, so this same probe records the original footer.
   const footer=await ev(`[...document.querySelectorAll('#settings-modal .modal-footer button')].map(b=>b.textContent.trim())`);
   if(JSON.stringify(footer)!==JSON.stringify(['Close'])) {footerFailures.push({width,theme,size,footer});continue;}
   const on=await ev(`document.getElementById('settings-show-scrollbars').checked`);
   await ev(`document.getElementById('settings-show-scrollbars').click();true`);
   await waitFor(`window.__writes.length===1 && document.getElementById('settings-show-scrollbars').dataset.saving!=='1'`,'switch saved');
   assert.deepEqual(await ev(`window.__writes[0]`),{show_scrollbars:!on});
   assert.equal(await ev(`import((window.__coralStatic||'/static/')+'state.js').then(m=>String(m.state.settings.show_scrollbars).toLowerCase())`),String(!on),'the open page holds the saved switch');
   assert.equal(await ev(`document.body.classList.contains('no-scrollbars')`),on,'the saved switch updates the current page');
   assert.equal(await ev(`(async()=>String((await(await fetch('/api/settings')).json()).settings.show_scrollbars).toLowerCase())()`),String(!on));
   if(width===1440&&theme==='dark'&&size===16) {
    await waitFor(`document.getElementById('settings-show-scrollbars').closest('.sv-row').querySelector('.settings-save-status').textContent===''`,'Saved clears after two seconds',4000);
    await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
    await ev(`window.showSettingsModal('general')`);
    await waitFor(`document.getElementById('settings-modal').style.display==='flex'`,'Settings after reload');
    assert.equal(await ev(`document.getElementById('settings-show-scrollbars').checked`),!on,'switch survives a full reload');
   }
   await ev(`window.__writes=[];document.getElementById('settings-tab-files').click();true`);
   const before=await ev(`document.getElementById('settings-file-search-mode').value`);
   // Use an existing valid option; inspect rather than assume a provider-specific list.
   const picked=await ev(`(() => {const e=document.getElementById('settings-file-search-mode');e.focus();e.value=[...e.options].find(o=>o.value!==e.value).value;e.dispatchEvent(new Event('change',{bubbles:true}));return e.value;})()`);
   await waitFor(`document.getElementById('settings-file-search-mode').closest('.sv-row').querySelector('[role=status]')?.textContent==='Saved'`,'Saved announced');
   assert.equal(await ev(`window.__writes.length`),1);
   assert.deepEqual(Object.keys(await ev(`window.__writes[0]`)),['file_search_mode']);
   assert.equal(await ev(`(async()=> (await (await fetch('/api/settings')).json()).settings.file_search_mode)()`),picked,'saved without another click');
   await ev(`(() => {window.__failSave=true;const e=document.getElementById('settings-file-search-mode');e.focus();e.value=${JSON.stringify(before)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`document.getElementById('settings-file-search-mode').closest('.sv-row').querySelector('[role=status]')?.textContent==='Not saved. Try again.'`,'row save failure');
   assert.equal(await ev(`document.getElementById('settings-file-search-mode').value`),picked,'failed change rolls back');
   if ((width===1440&&theme==='dark'&&size===16)||(width===390&&theme==='light'&&size===32)) await shot(`settings-autosave-error-${width}-${size}-${theme}`);
   // A text field waits for blur/Enter and sends only its own key.
   await ev(`window.__failSave=false;document.getElementById('settings-tab-agents').click();true`);
   await ev(`(() => {const e=document.getElementById('settings-working-dir');e.focus();e.value=e.value==='/tmp'?'/':'/tmp';e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
   assert.equal(await ev(`window.__writes.length`),2,'typing alone does not save');
   // A change dispatched in another row must not submit this unfinished text.
   await ev(`(() => {const s=document.getElementById('settings-agent-type');s.value=s.value==='codex'?'claude':'codex';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`window.__writes.length===3 && document.getElementById('settings-agent-type').dataset.saving!=='1'`,'independent row saved');
   assert.deepEqual(Object.keys(await ev(`window.__writes[2]`)),['default_agent_type']);
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   await waitFor(`window.__writes.length===4 && document.getElementById('settings-working-dir').dataset.saving!=='1'`,'text saved on Enter');
   assert.deepEqual(Object.keys(await ev(`window.__writes[3]`)),['default_working_dir']);
   await ev(`(() => {const e=document.getElementById('settings-permission-mode');e.focus();e.value=e.value==='auto'?'plan':'auto';e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`window.__writes.length===5 && document.getElementById('settings-permission-mode').dataset.saving!=='1'`,'permission choice saved');
   assert.deepEqual(Object.keys(await ev(`window.__writes[4]`)),['default_permission_mode']);
   // Text also commits on leaving the field, including after moving the caret within it.
   await ev(`(() => {const e=document.getElementById('settings-working-dir');e.focus();e.value=e.value==='/tmp'?'/':'/tmp';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));e.blur();return true;})()`);
   await waitFor(`window.__writes.length===6 && document.getElementById('settings-working-dir').dataset.saving!=='1'`,'text saved on blur after a caret click');
   assert.deepEqual(Object.keys(await ev(`window.__writes[5]`)),['default_working_dir']);

   // Refusals show the server's reason as text and keep the last saved value for a retry.
   await ev(`document.getElementById('settings-tab-files').click();window.__refuseSave='file_search_mode: refused <img src=x>';true`);
   await ev(`(() => {const e=document.getElementById('settings-file-search-mode');e.focus();e.value=${JSON.stringify(before)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`document.getElementById('settings-file-search-mode').closest('.sv-row').querySelector('[role=status]').textContent.includes('file_search_mode: refused <img src=x>')`, 'the 400 refusal reason is shown');
   assert.equal(await ev(`document.getElementById('settings-file-search-mode').value`),picked,'server refusal restores the last saved value');
   assert.equal(await ev(`document.getElementById('settings-file-search-mode').closest('.sv-row').querySelectorAll('img').length`),0,'server text is never HTML');
   if(width===390&&theme==='light'&&size===32) await shot('settings-autosave-refusal-390-32-light');
   await ev(`window.__refuseSave='';true`);
   await ev(`document.getElementById('settings-cancel-btn').click();true`);
   assert.equal(await ev(`document.getElementById('settings-modal').style.display`),'none');
   assert.notEqual(await ev(`document.getElementById('confirm-modal')?.style.display`),'flex','Close has no discard prompt');
   await ev(`window.showSettingsModal('files')`);
   await waitFor(`document.getElementById('settings-modal').style.display==='flex'`,'reopen');
   assert.equal(await ev(`document.getElementById('settings-file-search-mode').value`),picked,'reopening retains saved value');
  }
  assert.deepEqual(footerFailures,[],'footer has only Close');
  // Machine-only endpoints are stand-ins: never encrypt or restart the test server.
  await Emulation.setDeviceMetricsOverride({width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await ev(`(() => {const real=window.fetch,json=x=>Promise.resolve(new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}}));window.__specialWrites=[];window.__dbMode='disabled';window.__updateAuto=true;window.__installAuto=true;window.__channel='approved';
   window.fetch=(u,o={})=>{const path=new URL(String(u),location.href).pathname,method=o.method||'GET',body=o.body?JSON.parse(o.body):null;
    if(path==='/api/system/database-security'){if(method==='PUT'){window.__specialWrites.push({path,body});window.__dbMode=body.mode;}return json({encryption_compiled:true,feature_available:true,saved_mode:window.__dbMode,effective_mode:'disabled',restart_required:window.__dbMode!=='disabled',unlock_surface:'local'});}
    if(path==='/api/system/terminal-backend'){if(method==='PUT')window.__specialWrites.push({path,body});return json({saved:method==='PUT'?body.backend:'tmux',next:method==='PUT'?body.backend:'tmux',running:'tmux',choice:true,can_restart:false,running_agents:2});}
    if(path==='/api/sessions/live/sleep-all'){window.__specialWrites.push({path,body});return json({ok:true,slept:2});}
    if(path==='/api/system/restart')throw new Error('The stand-in forbids an actual restart');
    if(path==='/api/system/update/settings'){window.__specialWrites.push({path,body});window.__updateAuto=body.auto;return json({ok:true});}
    if(path==='/api/settings'&&method==='PUT'&&('update_auto_install' in body||'update_channel' in body)){window.__specialWrites.push({path,body});if('update_auto_install' in body)window.__installAuto=body.update_auto_install;if('update_channel' in body)window.__channel=body.update_channel;return json({ok:true});}
    if(path==='/api/system/update')return json({enabled:true,installed:'v2.0.66',state:'none',install_kind:'app',auto:window.__updateAuto,channel:window.__channel,auto_install:{on:window.__installAuto,state:window.__installAuto?'none':'off'},relaunch:{available:true,reason:'no_update',hub_allowed:false,ack:'test'},hub_relaunch:true});
    return real(u,o);
   };return true;})()`);
  await ev(`import((window.__coralStatic||'/static/')+'update_flag.js').then(m=>m.setUpdatesEnabled(true))`);
  await ev(`window.showSettingsModal('security')`);
  await waitFor(`document.getElementById('settings-database-encryption').dataset.shown==='disabled'&&!document.getElementById('settings-database-encryption').disabled`,'compiled encryption choice');
  await ev(`(() => {const e=document.getElementById('settings-database-encryption');e.focus();e.value='key_file';e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await waitFor(`document.getElementById('settings-database-encryption').closest('.sv-row').querySelector('.settings-save-status').textContent==='Saved'`,'encryption saved through its endpoint');
  assert.deepEqual(await ev(`window.__specialWrites`),[{path:'/api/system/database-security',body:{mode:'key_file'}}]);
  assert.equal(await ev(`document.getElementById('settings-database-encryption').disabled`),false,'select unlocks after the request');
  assert.match(await ev(`document.getElementById('settings-database-encryption-status').textContent`),/Saved: key_file/);
  await ev(`document.getElementById('settings-tab-agents').click(); document.getElementById('settings-defaults-advanced').open = true;true`);
  await waitFor(`document.getElementById('tb-choice').value==='tmux'`,'backend loaded');
  const chooseBackend=()=>ev(`(() => {const e=document.getElementById('tb-choice');e.focus();e.value='pty';e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await chooseBackend();await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`,'backend asks on change');
  assert.equal(await ev(`window.__specialWrites.length`),1,'nothing saved before confirmation');
  await ev(`window.hideConfirmModal();true`);
  await waitFor(`document.getElementById('tb-choice').dataset.saving!=='1'`,'backend cancel finishes');
  assert.equal(await ev(`document.getElementById('tb-choice').value`),'tmux','Cancel restores the saved backend');
  await chooseBackend();await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`,'backend asks on retry');
  await ev(`document.getElementById('confirm-modal-yes').click();true`);
  await waitFor(`document.getElementById('tb-choice').dataset.saving!=='1'`,'confirmed backend saved');
  assert.deepEqual(await ev(`window.__specialWrites.slice(1)`),[{path:'/api/sessions/live/sleep-all',body:{}},{path:'/api/system/terminal-backend',body:{backend:'pty'}}],'sleep precedes backend save');
  assert.equal(await ev(`document.getElementById('settings-modal').style.display`),'flex','row save leaves Settings open');
  // Replace the startup server status (updates are off in the isolated build) with the stand-in before opening its pane.
  await ev(`import((window.__coralStatic||'/static/')+'update_ui.js').then(m=>m.refreshUpdateStatus())`);
  await ev(`document.getElementById('settings-tab-updates').click();import((window.__coralStatic||'/static/')+'update_settings.js').then(m=>m.showUpdatesPane())`);
  await waitFor(`document.getElementById('settings-update-auto') && document.getElementById('settings-update-auto-install')`,'update rows loaded');
  for(const id of ['settings-update-auto','settings-update-auto-install','uc-agentic']) {
   await ev(`document.getElementById('${id}').focus();document.getElementById('${id}').click();true`);
   await waitFor(`document.getElementById('${id}').dataset.saving!=='1'`,'update row '+id+' saved');
  }
  assert.deepEqual(await ev(`window.__specialWrites.slice(3)`),[{path:'/api/system/update/settings',body:{auto:false}},{path:'/api/settings',body:{update_auto_install:false}},{path:'/api/settings',body:{update_channel:'agentic'}}],'each update choice uses its own endpoint and key');
  // The retention-kind row must save its changed key while hourly pruning is on.
  await ev(`document.getElementById('settings-tab-cleanup').click();true`);
  await waitFor(`document.getElementById('settings-retention-enabled').dataset.loaded==='1'`,'retention loaded');
  if(!await ev(`document.getElementById('settings-retention-enabled').checked`)) {await ev(`document.getElementById('settings-retention-enabled').click();true`);await waitFor(`document.getElementById('settings-retention-enabled').dataset.saving!=='1'`,'retention on saved');}
  await ev(`window.__writes=[];const k=document.getElementById('settings-prune-kind');k.focus();k.value=[...k.options].find(o=>o.value!==k.value).value;k.dispatchEvent(new Event('change',{bubbles:true}));true`);
  await waitFor(`document.getElementById('settings-prune-kind').dataset.saving!=='1'`,'prune kind saved');
  assert.deepEqual(Object.keys(await ev(`window.__writes[0]`)),['artifact_retention_kinds'],'row autosave covers the retention-kind key');

 } finally {await client.close();await guard.restore();}
})().catch(e=>{console.error(e);process.exit(1);});
