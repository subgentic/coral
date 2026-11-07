// Shipped role defaults, one-click narrow role limits, and explicit team choices.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { install: installTeam, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const full=['agent_spawn','file_read','file_write','shell','web_access'];
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');await installTeam(ev);await stubModels(ev);
   await ev(`import((window.__coralStatic||'/static/')+'state.js').then(m=>{delete m.state.settings.default_permission_mode;return true})`);
   const presets=await ev(`import((window.__coralStatic||'/static/')+'agent_presets.js').then(m=>m.AGENT_PRESETS.map(p=>({name:p.name,allow:p.capabilities.allow.slice().sort(),deny:p.capabilities.deny||[]})))`);
   assert.ok(presets.length>0);for(const p of presets){assert.deepEqual(p.allow,full,p.name+' shipped capabilities');assert.deepEqual(p.deny,[]);}
   const templates=await ev(`import((window.__coralStatic||'/static/')+'team_templates_ui.js').then(m=>m.BUILTIN_TEAM_TEMPLATES.flatMap(t=>t.agents.map(a=>a.capabilities.allow.slice().sort())))`);
   for(const caps of templates)assert.deepEqual(caps,full,'built-in team member starts full');
   for(const role of ['Security Reviewer','SEO Strategist','Research Analyst']){
    await ev(`(async()=>{const S=window.__coralStatic||'/static/';const p=(await import(S+'agent_presets.js')).AGENT_PRESETS.find(p=>p.name===${JSON.stringify(role)});const f=await import(S+'agent_config_form.js');document.getElementById('role-default-probe')?.remove();const host=document.createElement('main');host.id='role-default-probe';host.style.cssText='position:fixed;inset:0;overflow:auto;z-index:10000;background:var(--bg-primary);padding:12px';document.body.append(host);f.renderAgentConfigForm(host.id,{value:{...p,agentType:'claude'}});return true;})()`);
    const hint=await ev(`(()=>{const h=document.getElementById('role-default-probe'),b=[...h.querySelectorAll('button')].find(b=>b.textContent==="Apply the role's limits");return{words:h.textContent,visible:!!b&&!b.hidden&&b.getBoundingClientRect().height>0}})()`);
    assert.ok(hint.visible&&hint.words.includes('This role is a prompt, not a permission.'),role+' shows truthful role description and one-click limits');
    await ev(`[...document.querySelectorAll('#role-default-probe button')].find(b=>b.textContent==="Apply the role's limits").click();true`);
    await waitFor(`import((window.__coralStatic||'/static/')+'agent_config_form.js').then(m=>!m.getAgentConfig('role-default-probe').capabilities.allow.includes('file_write'))`,'role limits actually narrow the form');
    const config=await ev(`import((window.__coralStatic||'/static/')+'agent_config_form.js').then(m=>m.getAgentConfig('role-default-probe'))`);
    assert.equal(config.name,role);assert.equal(config.permissionMode,'auto','narrowing tools preserves the selected mode');assert.ok(config.prompt.length>0,'role instructions survive');
   }
   await ev(`document.getElementById('role-default-probe').remove();true`);
   await openNewTeam(ev,waitFor);
   await waitFor(`!!document.getElementById('team-permission-mode')`,'team permission field');
   assert.equal(await ev(`document.getElementById('team-permission-mode').value`),'auto','new Claude team follows shipped default');
   await ev(`const e=document.getElementById('team-permission-mode');e.value='default';e.dispatchEvent(new Event('change',{bubbles:true}));const t=document.getElementById('team-agent-type');t.value='codex';t.dispatchEvent(new Event('change',{bubbles:true}));true`);
   assert.equal(await ev(`document.getElementById('team-permission-mode').value`),'default','explicit Default survives provider change');
   assert.deepEqual(await ev(`import((window.__coralStatic||'/static/')+'preset_enforcement.js').then(m=>[m.defaultPermissionMode({default_permission_mode:'default'},'hermes'),m.defaultPermissionMode({},'hermes')])`),['default','bypassPermissions'],'stored lower Hermes choice wins over new shipped yolo default');
  }
  console.log('PASS shipped full presets, visible role limits and explicit team Default at desktop/phone');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
