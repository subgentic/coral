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
    const before=await ev('window.__riskChanges.length');
    const previous=await ev(`(() => {const e=document.getElementById('${id}');return e.type==='checkbox'?e.checked:e.value;})()`);
    await choose(id,value);
    await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`,'enabling asks');
    assert.equal(await ev('window.__riskChanges.length'),before,'no save before confirmation');
    await ev(`document.querySelector('#confirm-modal [data-on-click="m-hide-confirm-modal"]').click();true`);
    assert.equal(await ev('window.__riskChanges.length'),before,'Cancel writes nothing');
    assert.equal(await ev(`(() => {const e=document.getElementById('${id}');return e.type==='checkbox'?e.checked:e.value;})()`),previous,'Cancel restores the prior value');
    assert.equal(await ev('document.activeElement.id'),id,'Cancel returns focus to the changed control');
    await choose(id,value);await ev(`document.getElementById('confirm-modal-yes').click();true`);
    assert.equal(await ev('window.__riskChanges.length'),before+1,'confirmation dispatches one save');
    assert.match(await ev(`document.getElementById('settings-safety-summary').textContent`),new RegExp('Safety checks turned off: '+count));
    assert.match(await ev(`document.getElementById('${id}-risk').textContent`),/⚠ /);
   }
   await choose('settings-codex-trust-hooks',true);
   assert.notEqual(await ev(`document.getElementById('confirm-modal').style.display`),'flex','trusting Coral’s Codex hooks is an ordinary default, without confirmation');
   assert.equal(await ev(`!!document.getElementById('settings-codex-trust-hooks-risk')`),false,'Codex trust has no risk warning');
   assert.match(await ev(`document.getElementById('settings-safety-summary').textContent`),/Safety checks turned off: 6/,'Codex trust is a safety check that is off: counted (#16346)');
   assert.match(await ev(`document.getElementById('settings-safety-summary').textContent`),/Skip Codex's review of Coral's hooks/,'and named in the list');
   await ev(`document.getElementById('settings-cloud-hub-operator').closest('.sv-row').hidden=true;true`);
   await waitFor(`/turned off: 5/.test(document.getElementById('settings-safety-summary').textContent)`,'a switch Settings hides (no Hub link) is not counted (#16346)');
   await ev(`document.getElementById('settings-cloud-hub-operator').closest('.sv-row').hidden=false;true`);
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
   const real=window.fetch,json=(x,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}}));window.__riskHubWrites=[];window.__riskHub={operatorDisabled:true,signinEnabled:false};window.__riskWrites=[];window.__riskSaved={remote_access_enabled:false,debug_input_log:false};
   window.fetch=(u,o={})=>{const path=new URL(String(u),location.href).pathname;if(path==='/api/settings'&&o.method==='PUT'){const v=JSON.parse(o.body);window.__riskWrites.push(v);if(window.__riskRefuse)return json({error:'Permission edit refused'},400);Object.assign(window.__riskSaved,v);return json({ok:true});}if(path==='/api/cloud/status')return json({configured:true,state:'connected',max_mode:'interact',hub_url:'https://hub.example'});
    if(path==='/api/system/hub-operator'){if(o.method==='PUT'){const body=JSON.parse(o.body);window.__riskHubWrites.push({path,body});window.__riskHub.operatorDisabled=body.disabled;}return json({linked:true,disabled:window.__riskHub.operatorDisabled,enabled:!window.__riskHub.operatorDisabled,recent_actions:[]});}
    if(path==='/api/system/auth-status')return json({authenticated:true,method:'session',password_set:true,local:true});
    if(path==='/api/auth/sessions')return json({sessions:[],recent:[]});
    if(path==='/api/auth/hub-origins')return json({origins:[]});
    if(path==='/api/auth/hub-signin'){if(o.method==='PUT'){const body=JSON.parse(o.body);window.__riskHubWrites.push({path,body});window.__riskHub.signinEnabled=body.enabled;}return json({enabled:window.__riskHub.signinEnabled,linked:true,offer:false,owner_known:true});}
    if(path==='/api/system/privacy')return json({remote_access_enabled:window.__riskSaved.remote_access_enabled,remote_access_effective:false,debug_input_log:{enabled:window.__riskSaved.debug_input_log,forced:false,path:'test-input.log'},bind_host:'127.0.0.1'});return real(u,o);};return true;})()`);
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
   if(id==='settings-permission-mode') await waitFor(`!!document.getElementById('${id}')._segmented?.querySelector('[aria-checked="true"]')`, 'visible permission mode control rendered');
   await ev(`document.getElementById('settings-tab-security').click();true`);
   const label=id==='settings-permission-mode'?(value==='dontAsk'?"Don't ask":'Bypass permissions'):id==='settings-remote-access-enabled'?'Remote access':'Record what Coral types';
   await ev(`document.querySelector('#settings-safety-summary details').open=true;[...document.querySelectorAll('#settings-safety-summary button')].find(b=>b.textContent===${JSON.stringify(label)}).click();true`);
   await waitFor(`(()=>{const e=document.getElementById('${id}');const target=e._segmented?.querySelector('[aria-checked="true"]')||e;return !e.closest('.settings-pane').hidden && target.getClientRects().length>0 && document.activeElement===target;})()`, 'summary opens the pane and focuses the rendered risk control');
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

  // The real Hub rows have independent write routes: Cancel reaches neither one.
  await ev(`document.documentElement.dataset.theme='light';true`);
  for(const [id,group,path,body] of [
   ['settings-cloud-hub-operator','network','/api/system/hub-operator',{disabled:false}],
   ['sec-hub-enabled','security','/api/auth/hub-signin',{enabled:true}],
  ]) {
   await ev(`document.getElementById('settings-tab-${group}').click();true`);
   await waitFor(`!!document.getElementById('${id}-risk') && !document.getElementById('${id}').checked`, 'real Hub row loaded with permission off');
   await ev(`(() => {const e=document.getElementById('${id}');for(let p=e;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;e.scrollIntoView({block:'center'});e.focus();})()`);
   assert.equal(await ev(`document.getElementById('${id}').checkVisibility()`),true,'the real Hub control is visible');
   const before=await ev('window.__riskHubWrites.length'), settingsBefore=await ev('window.__riskWrites.length');
   await ev(`document.getElementById('${id}').click()`);
   await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`, 'Hub permission asks before saving');
   assert.equal(await ev('window.__riskHubWrites.length'),before,'Hub permission has no write before approval');
   await ev(`document.querySelector('#confirm-modal [data-on-click="m-hide-confirm-modal"]').click()`);
   assert.equal(await ev(`document.getElementById('${id}').checked`),false,'Cancel restores the real Hub switch');
   assert.equal(await ev('document.activeElement.id'),id,'Cancel returns focus to the real Hub switch');
   assert.equal(await ev('window.__riskHubWrites.length'),before,'Cancel makes no Hub write');
   assert.equal(await ev('window.__riskWrites.length'),settingsBefore,'Cancel makes no settings write');
   await ev(`document.getElementById('${id}').click()`);
   await waitFor(`document.getElementById('confirm-modal').style.display==='flex'`, 'Hub permission asks again');
   await ev(`document.getElementById('confirm-modal-yes').click()`);
   await waitFor(`window.__riskHubWrites.length===${before+1} && document.getElementById('${id}')?.checked && !document.getElementById('${id}').disabled`, 'confirmed real Hub switch saved and read back');
   assert.deepEqual(await ev(`window.__riskHubWrites[${before}]`),{path,body},'the confirmed real Hub row writes its own route once');
   assert.equal(await ev('window.__riskWrites.length'),settingsBefore,'Hub permissions never write the Settings endpoint');
   await waitFor(`!!document.getElementById('${id}-risk') && !document.getElementById('${id}-risk').hidden`, 'saved Hub permission has a warning');
   const colors=await ev(`(() => {const note=document.getElementById('${id}-risk'),probe=document.createElement('span');probe.style.color='var(--warning-text)';note.append(probe);const colors={actual:getComputedStyle(note).color,expected:getComputedStyle(probe).color};probe.remove();return colors;})()`);
   assert.equal(colors.actual,colors.expected,'risk warning uses the theme token for readable warning text');
  }

  await Emulation.setDeviceMetricsOverride({width:390,height:1000,deviceScaleFactor:1,mobile:true});
  await ev(`document.documentElement.dataset.theme='light';document.documentElement.style.fontSize='32px';document.getElementById('settings-tab-security').click();document.getElementById('settings-pane-security').scrollTop=0;true`);
  await shot('settings-risks-active-summary-390-32-light');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
