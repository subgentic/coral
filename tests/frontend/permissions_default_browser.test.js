// Shipped role defaults, one-click narrow role limits, and explicit team choices.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { install: installTeam, openNewTeam, stubModels, T, N } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
const { guardSettings } = require('./helpers/settings_guard');
(async()=>{
 const guard=await guardSettings();
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const full=['agent_spawn','file_read','file_write','shell','web_access'];
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');await installTeam(ev);await stubModels(ev);
   const actual=await ev(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(async r=>({status:r.status,body:await r.json()}))`);
   assert.equal(actual.status,200,'real integrated owner disclosure route is readable');
   assert.equal(actual.body.id,'full-permissions-3','pin the final security-reviewed disclosure version');
   assert.match(actual.body.text,/run as you, with every file you can reach/,'real server text states the operating-system authority');
   assert.match(actual.body.text,/Hermes/,'real server disclosure names Hermes Bypass');
   await ev(`fetch('/api/launch-disclosure/ack',{method:'DELETE'}).then(r=>r.ok)`);
   await ev(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_permission_mode:''})}).then(r=>r.ok)`);
   if(process.env.CORAL_TEST_STRICT) for(const path of ['/api/sessions/launch','/api/sessions/launch-team']){
    const payload=path.endsWith('launch-team')?{board_name:'disclosure-ui-probe',working_dir:'/tmp/coral-disclosure-no-folder',agent_type:'claude',flags:['--permission-mode','auto'],agents:[{name:'Orchestrator',prompt:'Coordinate'}]}:{name:'disclosure-ui-probe',working_dir:'/tmp/coral-disclosure-no-folder',agent_type:'claude',flags:['--permission-mode','auto']};
    const refusal=await ev(`fetch(${JSON.stringify(path)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(payload))}}).then(async r=>({status:r.status,body:await r.json()}))`);
    assert.equal(refusal.status,409,path+': real authenticated dialog request is gated before missing-folder checks/spawn');assert.equal(refusal.body.code,'launch_disclosure_required');
   }

   await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
   await waitFor(`!!document.getElementById('launch-disclosure-banner')`,'real unseen server record shows the banner');
   await ev(`[...document.querySelectorAll('#launch-disclosure-banner button')].find(b=>b.textContent==="I've read this").click();true`);
   await waitFor(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen===true)`,'owner acknowledgement persisted on the real server');
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');await installTeam(ev);await stubModels(ev);
   await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
   assert.equal(await ev(`!!document.getElementById('launch-disclosure-banner')`),false,'real acknowledgement survives full reload');
   await ev(`import((window.__coralStatic||'/static/')+'state.js').then(m=>{delete m.state.settings.default_permission_mode;return true})`);
   const presets=await ev(`import((window.__coralStatic||'/static/')+'agent_presets.js').then(m=>m.AGENT_PRESETS.map(p=>({name:p.name,allow:p.capabilities.allow.slice().sort(),deny:p.capabilities.deny||[]})))`);
   assert.ok(presets.length>0);for(const p of presets){assert.deepEqual(p.allow,full,p.name+' shipped capabilities');assert.deepEqual(p.deny,[]);}
   const templates=await ev(`import((window.__coralStatic||'/static/')+'team_templates_ui.js').then(m=>m.BUILTIN_TEAM_TEMPLATES.flatMap(t=>t.agents.map(a=>a.capabilities.allow.slice().sort())))`);
   for(const caps of templates)assert.deepEqual(caps,full,'built-in team member starts full');
   assert.equal(presets.length,15,'exercise every shipped preset');
   for(const role of presets.map(p=>p.name)){
    await ev(`(async()=>{const S=window.__coralStatic||'/static/';const p=(await import(S+'agent_presets.js')).AGENT_PRESETS.find(p=>p.name===${JSON.stringify(role)});const f=await import(S+'agent_config_form.js');document.getElementById('role-default-probe')?.remove();const host=document.createElement('main');host.id='role-default-probe';host.style.cssText='position:fixed;inset:0;overflow:auto;z-index:10000;background:var(--bg-primary);padding:12px';document.body.append(host);f.renderAgentConfigForm(host.id,{showPreset:false,value:{...p,agentType:'claude'}});return true;})()`);
    const hint=await ev(`(()=>{const h=document.getElementById('role-default-probe'),b=[...h.querySelectorAll('button')].find(b=>b.textContent==="Apply the role's limits");return{words:h.textContent,visible:!!b&&!b.hidden&&b.getBoundingClientRect().height>0}})()`);
    assert.ok(hint.visible&&hint.words.includes('This role is a prompt, not a permission.'),role+' shows truthful role description and one-click limits');
    await ev(`import((window.__coralStatic||'/static/')+'agent_presets.js').then(m=>window.__expectedRoleLimits=m.AGENT_PRESETS.find(p=>p.name===${JSON.stringify(role)}).roleLimits.allow.slice().sort())`);
    await ev(`[...document.querySelectorAll('#role-default-probe button')].find(b=>b.textContent==="Apply the role's limits").click();true`);
    await waitFor(`import((window.__coralStatic||'/static/')+'agent_config_form.js').then(m=>JSON.stringify(m.getAgentConfig('role-default-probe').capabilities.allow.slice().sort())===JSON.stringify(window.__expectedRoleLimits))`,'role limits actually narrow the form');
    const config=await ev(`import((window.__coralStatic||'/static/')+'agent_config_form.js').then(m=>m.getAgentConfig('role-default-probe'))`);
    assert.equal(config.name,role);assert.equal(config.permissionMode,'auto','narrowing tools preserves the selected mode');if(role!=='Terminal')assert.ok(config.prompt.length>0,'role instructions survive');
    assert.deepEqual(config.capabilities.allow.slice().sort(),await ev('window.__expectedRoleLimits'),role+' applies its exact saved tool choices');
   }
   await ev(`document.getElementById('role-default-probe').remove();true`);
   await openNewTeam(ev,waitFor);
   await waitFor(`!!document.getElementById('team-permission-mode')`,'team permission field');
   assert.equal(await ev(`document.getElementById('team-permission-mode').value`),'auto','new Claude team follows shipped default');
   const team=T(ev,waitFor);await team.to(3,{name:'permissions-probe',folder:'/work/payments-app'});
   await ev(`(()=>{const real=window.fetch;window.__teamDefaultPosts=[];window.fetch=(input,options={})=>{if(new URL(String(input),location.href).pathname==='/api/sessions/launch-team'){window.__teamDefaultPosts.push(JSON.parse(options.body));return Promise.resolve(Response.json({error:'Test stopped before spawning'},{status:403}));}return real(input,options)};return true})()`);
   await team.click('button',N.launch);await waitFor(`window.__teamDefaultPosts.length===1`,'new team launch payload');
   assert.ok(await ev(`window.__teamDefaultPosts[0].flags.join(' ').includes('--permission-mode auto') && window.__teamDefaultPosts[0].agents.every(a=>a.permission_mode!=='default')`),'untouched members inherit the new Auto team default rather than sending explicit Default');
   await waitFor(`!document.getElementById('launch-team-go').disabled`,'launch failure restores button');
   await ev(`(()=>{const row=document.querySelector('#team-agents-list .team-agent-row');const e=document.getElementById(row.dataset.acfId).querySelector('.acf-permission-mode');e.value='default';e.dispatchEvent(new Event('change',{bubbles:true}));window.launchTeam();return true;})()`);
   await waitFor(`window.__teamDefaultPosts.length===2`,'explicit member Default payload');
   assert.equal(await ev(`window.__teamDefaultPosts[1].agents[0].permission_mode`),'default','member explicit Default is sent as Default');
   await waitFor(`!document.getElementById('launch-team-go').disabled`,'second launch settles');
   await ev(`(async()=>{const S=window.__coralStatic||'/static/';const {state}=await import(S+'state.js');state.settings.saved_team_templates=JSON.stringify([{name:'Saved narrow',agents:[{name:'Orchestrator',prompt:'Coordinate',capabilities:{allow:['file_read']}}]}]);(await import(S+'team_dialogs.js'))._pickTeamTemplate('Saved narrow');window.launchTeam();return true;})()`);
   await waitFor(`window.__teamDefaultPosts.length===3`,'saved template launch payload');
   assert.deepEqual(await ev(`({mode:window.__teamDefaultPosts[2].agents[0].permission_mode,caps:window.__teamDefaultPosts[2].agents[0].capabilities})`),{mode:'default',caps:{allow:['file_read']}},'saved template lower mode and capabilities keep their prior meaning');
   await waitFor(`!document.getElementById('launch-team-go').disabled`,'saved narrow launch settles');
   await ev(`(async()=>{const S=window.__coralStatic||'/static/';const {state}=await import(S+'state.js');state.settings.saved_team_templates=JSON.stringify([{name:'Saved plan',agents:[{name:'Orchestrator',prompt:'Coordinate',flags:'--permission-mode plan',capabilities:{allow:['file_read']}}]}]);(await import(S+'team_dialogs.js'))._pickTeamTemplate('Saved plan');window.launchTeam();return true;})()`);
   await waitFor(`window.__teamDefaultPosts.length===4`,'saved explicit mode launch payload');
   assert.deepEqual(await ev(`window.__teamDefaultPosts[3].agents[0].flags`),['--permission-mode','plan'],'saved member keeps its explicit Plan mode');
   await ev(`(()=>{const e=document.getElementById('team-permission-mode');e.value='default';e.dispatchEvent(new Event('change',{bubbles:true}));const t=document.getElementById('team-agent-type');t.value='codex';t.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   assert.equal(await ev(`document.getElementById('team-permission-mode').value`),'default','explicit Default survives provider change');
   assert.deepEqual(await ev(`import((window.__coralStatic||'/static/')+'preset_enforcement.js').then(m=>[m.defaultPermissionMode({default_permission_mode:'default'},'hermes'),m.defaultPermissionMode({},'hermes')])`),['default','bypassPermissions'],'stored lower Hermes choice wins over new shipped yolo default');
   await ev(`(async()=>{const S=window.__coralStatic||'/static/';(await import(S+'launch_core.js')).hideLaunchModal();const real=window.fetch;window.__disclosure={id:'full-permissions-1',text:'Full tool permissions <b>are not role limits</b>. Change the default in Settings.',seen:false};window.__launchAudit={launch:[],ack:[],failAck:false};window.fetch=(input,options={})=>{const path=new URL(String(input),location.href).pathname;const json=(data,status=200)=>Promise.resolve(Response.json(data,{status}));if(path==='/api/launch-disclosure')return json(window.__disclosure);if(path==='/api/launch-disclosure/ack'){window.__launchAudit.ack.push(JSON.parse(options.body));if(window.__launchAudit.failAck)return json({error:'owner_only'},403);window.__disclosure.seen=true;return json({id:window.__disclosure.id,seen:true});}if(path==='/api/sessions/launch'||path==='/api/sessions/launch-team'){window.__launchAudit.launch.push({path,body:JSON.parse(options.body)});return window.__disclosure.seen?json({session_id:'new-agent',name:'new-agent',permission_mode:'auto'}):json({code:'launch_disclosure_required',disclosure:window.__disclosure},409);}return real(input,options)};await(await import(S+'launch_disclosure.js')).refreshLaunchDisclosure();return true;})()`);
   await waitFor(`document.getElementById('launch-disclosure-banner')?.textContent.includes('Full tool permissions')`,'unseen disclosure stays in dashboard banner');
   assert.equal(await ev(`!!document.querySelector('#launch-disclosure-banner b')`),false,'server text is text, never markup');
   await ev(`window.showSettingsModal('agents').then(()=>true)`);
   await waitFor(`!!document.getElementById('settings-permission-mode')`,'settings default exists');
   await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
   await waitFor(`document.getElementById('settings-launch-disclosure')?.textContent===window.__disclosure.text`,'Settings repeats disclosure beside default');
   for(const outcome of ['cancel','refused','continue']){
    await ev(`window.__launchAudit.failAck=${outcome==='refused'};window.__disclosure.seen=false;window.__launchResult='pending';window.__launchPayload={name:'frozen-name',working_dir:'/work/payments-app'};import((window.__coralStatic||'/static/')+'launch_core.js').then(m=>m._launchOn('local','/api/sessions/launch',window.__launchPayload,'claude')).then(result=>{window.__launchResult=result||'stopped'});true`);
    await waitFor(`document.getElementById('confirm-modal-message')?.textContent===window.__disclosure.text && document.getElementById('confirm-modal')?.getClientRects().length>0`,'disclosure before launch');
    const before=await ev('window.__launchAudit.launch.length');
    await ev(`window.__launchPayload.name='edited-after-request';true`);
    if(outcome==='cancel')await ev(`[...document.querySelectorAll('#confirm-modal button')].find(b=>b.textContent.trim()==='Cancel').click();true`);
    else await ev(`document.getElementById('confirm-modal-yes').click();true`);
    await waitFor(`window.__launchResult!=='pending'`,'launch choice settles');
    assert.equal(await ev('window.__launchAudit.launch.length'),before+(outcome==='continue'?1:0),outcome+': no launch retry without successful owner acknowledgement');
    if(outcome==='continue')assert.deepEqual(await ev(`window.__launchAudit.launch.slice(-2).map(x=>x.body)`),[{name:'frozen-name',working_dir:'/work/payments-app',home_folder_ask:true},{name:'frozen-name',working_dir:'/work/payments-app',home_folder_ask:true}],'retry uses frozen identical payload');
   }
   assert.deepEqual(await ev('window.__launchAudit.ack'),[{id:'full-permissions-1'},{id:'full-permissions-1'}],'reading/cancelling never acknowledges');
   await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
   assert.equal(await ev(`!!document.getElementById('launch-disclosure-banner')`),false,'acknowledged server state removes banner');

  }
  console.log('PASS shipped full presets, visible role limits and explicit team Default at desktop/phone');
 }finally{try{await guard.restore()}finally{await client.close()}}
})().catch(e=>{console.error(e);process.exitCode=1});
