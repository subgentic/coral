// ST3: the lazy Settings risk controller gates changes before any save handler runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const missing=[];
 const shot=async name=>{if(!process.env.CORAL_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1440,390])for(const theme of ['dark','light'])for(const size of [16,32]) {
   await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`window.showSettingsModal('security')`);
   await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${size}px';true`);
   await shot(`settings-risks-${width}-${size}-${theme}`);
   if(!await ev(`!!document.getElementById('settings-safety-summary')`)){missing.push({width,theme,size});continue;}
   // Exercise the six remaining risky values with isolated controls: no encryption, remote-access or Hub setting is written.
   await ev(`(async()=>{
    document.getElementById('settings-modal').remove();
    const modal=document.createElement('div');modal.id='settings-modal';
    const pane=document.createElement('section');pane.id='settings-pane-security';pane.className='settings-pane';pane.dataset.group='security';modal.append(pane);
    const ids=['settings-permission-mode','settings-codex-trust-hooks','settings-remote-access-enabled','settings-cloud-hub-operator','sec-hub-enabled','settings-debug-input-log','tb-autowake-on'];
    for(const id of ids){const row=document.createElement('div');row.className='sv-row';const label=document.createElement('label');label.textContent=id;const input=document.createElement(id==='settings-permission-mode'?'select':'input');input.id=id;if(input.tagName==='SELECT'){for(const v of ['default','bypassPermissions','dontAsk'])input.add(new Option(v,v));}else input.type='checkbox';label.htmlFor=id;row.append(label,input);pane.append(row);}
    document.body.append(modal);document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${size}px';
    const m=await import((window.__coralStatic||'/static/')+'settings_risks.js');m.wireSettingsRisks(modal);
    window.__riskChanges=[];modal.addEventListener('change',e=>window.__riskChanges.push(e.target.id));return true;
   })()`);
   const choose=(id,value)=>ev(`(()=>{const e=document.getElementById('${id}');e.focus();${typeof value==='boolean'?`e.checked=${value}`:`e.value=${JSON.stringify(value)}`};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   for(const [id,value,count] of [ ['settings-permission-mode','bypassPermissions',1],['settings-permission-mode','dontAsk',1],['settings-remote-access-enabled',true,2],['settings-cloud-hub-operator',true,3],['sec-hub-enabled',true,4],['settings-debug-input-log',true,5] ]) {
    const before=await ev('window.__riskChanges.length');await choose(id,value);
    await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`,'enabling asks');
    assert.equal(await ev('window.__riskChanges.length'),before,'no save before confirmation');
    await ev(`window.hideConfirmModal();true`);
    assert.equal(await ev('window.__riskChanges.length'),before,'Cancel writes nothing');
    await choose(id,value);await ev(`document.getElementById('confirm-modal-yes').click();true`);
    assert.equal(await ev('window.__riskChanges.length'),before+1,'confirmation dispatches one save');
    assert.match(await ev(`document.getElementById('settings-safety-summary').textContent`),new RegExp('Safety checks turned off: '+count));
    assert.match(await ev(`document.getElementById('${id}-risk').textContent`),/⚠ /);
   }
   await choose('settings-codex-trust-hooks',true);
   assert.notEqual(await ev(`document.getElementById('confirm-modal').style.display`),'flex','trusting Coral’s Codex hooks is an ordinary default, without confirmation');
   assert.equal(await ev(`!!document.getElementById('settings-codex-trust-hooks-risk')`),false,'Codex trust has no risk warning');
   assert.match(await ev(`document.getElementById('settings-safety-summary').textContent`),/Safety checks turned off: 5/,'Codex trust does not increase the count');
   await choose('tb-autowake-on',true);
   assert.match(await ev(`document.querySelector('.settings-wake-warning').textContent`),/saved permissions.*bypass/);
   for(const id of ['settings-codex-trust-hooks','settings-remote-access-enabled','settings-cloud-hub-operator','sec-hub-enabled','settings-debug-input-log'])await choose(id,false);
   await choose('settings-permission-mode','default');
   assert.equal(await ev(`document.getElementById('settings-safety-summary').textContent`),'All safety checks are on');
   assert.equal(await ev(`document.querySelectorAll('.settings-risk-warning:not([hidden]):not(.settings-wake-warning)').length`),0);
  }
  assert.deepEqual(missing,[],'Security shows its safety summary at every width, theme and text size');
  // Drive the real Settings rows through autosave, without changing the machine's saved security settings.
  await Emulation.setDeviceMetricsOverride({width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await ev(`(async()=>{const st=(await import((window.__coralStatic||'/static/')+'state.js')).state;st.settings={...st.settings,default_permission_mode:'default',codex_trust_hooks:'true',debug_input_log:'false'};
   const real=window.fetch,json=(x,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}}));window.__riskWrites=[];window.__riskSaved={remote_access_enabled:false,debug_input_log:false};
   window.fetch=(u,o={})=>{const path=new URL(String(u),location.href).pathname;if(path==='/api/settings'&&o.method==='PUT'){const v=JSON.parse(o.body);window.__riskWrites.push(v);if(window.__riskRefuse)return json({error:'Permission edit refused'},400);Object.assign(window.__riskSaved,v);return json({ok:true});}if(path==='/api/system/privacy')return json({remote_access_enabled:window.__riskSaved.remote_access_enabled,remote_access_effective:false,debug_input_log:{enabled:window.__riskSaved.debug_input_log,forced:false,path:'test-input.log'},bind_host:'127.0.0.1'});return real(u,o);};return true;})()`);
  await ev(`window.showSettingsModal('agents')`);
  for(const [id,value,key,group] of [ ['settings-permission-mode','bypassPermissions','default_permission_mode','agents'],['settings-permission-mode','dontAsk','default_permission_mode','agents'],['settings-remote-access-enabled',true,'remote_access_enabled','network'],['settings-debug-input-log',true,'debug_input_log','security'] ]) {
   await ev(`document.getElementById('settings-tab-${group}').click();true`);
   const before=await ev('window.__riskWrites.length');
   await ev(`(()=>{const e=document.getElementById('${id}');e.focus();${typeof value==='boolean'?`e.checked=${value}`:`e.value=${JSON.stringify(value)}`};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`,'real row asks before saving');
   assert.equal(await ev('window.__riskWrites.length'),before);
   await ev(`document.getElementById('confirm-modal-yes').click();true`);
   await waitFor(`window.__riskWrites.length===${before+1} && document.getElementById('${id}').dataset.saving!=='1'`,'real row saved once');
   assert.deepEqual(await ev(`window.__riskWrites[${before}]`),{[key]:value},'only the confirmed row is saved');
   assert.equal(await ev(`import((window.__coralStatic||'/static/')+'state.js').then(m=>String(m.state.settings['${key}']).toLowerCase())`),String(value).toLowerCase(),'current page retains confirmed value');
   await ev(`document.getElementById('settings-tab-security').click();true`);
   const label=id==='settings-permission-mode'?(value==='dontAsk'?"Don't ask":'Bypass permissions'):id==='settings-remote-access-enabled'?'Remote access':'Record what Coral types';
   await ev(`[...document.querySelectorAll('#settings-safety-summary button')].find(b=>b.textContent===${JSON.stringify(label)}).click();true`);
   assert.equal(await ev(`(()=>{const e=document.getElementById('${id}');return document.activeElement===(e._segmented?.querySelector('[aria-checked="true"]')||e);})()`),true,'summary navigates and focuses the visible risk row');
   const warning=await ev(`document.getElementById('${id}-risk').textContent`);assert.match(warning,/⚠ /);
   await shot(`settings-risks-active-${id}-${typeof value==='boolean'?'on':value}`);
   if(id==='settings-permission-mode'&&value==='dontAsk') {
    await ev(`window.__riskRefuse=true;const e=document.getElementById('settings-permission-mode');e.focus();e.value='bypassPermissions';e.dispatchEvent(new Event('change',{bubbles:true}));true`);
    await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`,'risky edit confirms before refusal');
    await ev(`document.getElementById('confirm-modal-yes').click();true`);
    await waitFor(`document.getElementById('settings-permission-mode').dataset.saving!=='1'`,'refused risky edit finishes');
    assert.equal(await ev(`document.getElementById('settings-permission-mode').value`),'dontAsk','refusal restores prior risky choice');
    assert.notEqual(await ev(`document.getElementById('confirm-modal').style.display`),'flex','rollback never asks to enable the restored choice');
    assert.match(await ev(`document.getElementById('settings-permission-mode').closest('.sv-row').querySelector('.settings-save-status').textContent`),/Permission edit refused/);
    await ev(`window.__riskRefuse=false;true`);
   }

  }

  await Emulation.setDeviceMetricsOverride({width:390,height:1000,deviceScaleFactor:1,mobile:true});
  await ev(`document.documentElement.dataset.theme='light';document.documentElement.style.fontSize='32px';document.getElementById('settings-tab-security').click();document.getElementById('settings-pane-security').scrollTop=0;true`);
  await shot('settings-risks-active-summary-390-32-light');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
