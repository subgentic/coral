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
  await Page.addScriptToEvaluateOnNewDocument({source:`(() => { const real=window.fetch;window.__writes=[];window.__failSave=false;window.fetch=(u,o={})=>{if(new URL(String(u),location.origin).pathname==='/api/settings'&&o.method==='PUT'){window.__writes.push(JSON.parse(o.body));if(window.__failSave)return Promise.reject(new TypeError('Failed to fetch'));}return real(u,o);};})()`});
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

   await ev(`document.getElementById('settings-cancel-btn').click();true`);
   assert.equal(await ev(`document.getElementById('settings-modal').style.display`),'none');
   assert.notEqual(await ev(`document.getElementById('confirm-modal')?.style.display`),'flex','Close has no discard prompt');
   await ev(`window.showSettingsModal('files')`);
   await waitFor(`document.getElementById('settings-modal').style.display==='flex'`,'reopen');
   assert.equal(await ev(`document.getElementById('settings-file-search-mode').value`),picked,'reopening retains saved value');
  }
  assert.deepEqual(footerFailures,[],'footer has only Close');
 } finally {await client.close();await guard.restore();}
})().catch(e=>{console.error(e);process.exit(1);});
