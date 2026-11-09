// Shipped role defaults, one-click narrow role limits, and explicit team choices.
const assert = require('node:assert/strict');
const { touchTap, touchScroll } = require('./helpers/touch_tap');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { install: installTeam, openNewTeam, stubModels, T, N } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
const { guardSettings } = require('./helpers/settings_guard');
const timings=[];
const recordTiming=row=>{timings.push(row);if(process.env.CORAL_LAUNCH_TIMING_REPORT)require('node:fs').writeFileSync(process.env.CORAL_LAUNCH_TIMING_REPORT,JSON.stringify(timings,null,2)+'\n');};
(async()=>{
 const guard=await guardSettings();
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const snapshot=async(label,width)=>{if(!process.env.CORAL_SCREENSHOT_DIR)return;const fs=require('node:fs');fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});for(const size of [16,32]){await ev(`document.documentElement.style.fontSize='${size}px';true`);await ev(require('./helpers/wait').framesJs(3));fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${width}-${size}-${label}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}await ev(`document.documentElement.style.fontSize='';true`);};
 const full=['agent_spawn','file_read','file_write','shell','web_access'];
 const dismissChecks=[];
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');await installTeam(ev);await stubModels(ev);
   const actual=await ev(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(async r=>({status:r.status,body:await r.json()}))`);
   assert.equal(actual.status,200,'real integrated owner disclosure route is readable');
   assert.equal(actual.body.id,'full-permissions-4','pin the final security-reviewed disclosure version');
   assert.equal(actual.body.text,'Agents default to auto mode. Choose a different permission mode when you launch an agent or set a default in Settings.','real server keeps the Operator-approved wording');
   await ev(`fetch('/api/launch-disclosure/ack',{method:'DELETE'}).then(r=>r.ok)`);
   await ev(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_permission_mode:''})}).then(r=>r.ok)`);
   if(process.env.CORAL_TEST_STRICT) for(const path of ['/api/sessions/launch','/api/sessions/launch-team']){
    const payload=path.endsWith('launch-team')?{board_name:'disclosure-ui-probe',working_dir:'/tmp/coral-disclosure-no-folder',agent_type:'claude',flags:['--permission-mode','auto'],agents:[{name:'Orchestrator',prompt:'Coordinate'}]}:{name:'disclosure-ui-probe',working_dir:'/tmp/coral-disclosure-no-folder',agent_type:'claude',flags:['--permission-mode','auto']};
    const requestStarted=Date.now();
    const refusal=await ev(`fetch(${JSON.stringify(path)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(payload))}}).then(async r=>({status:r.status,body:await r.json()}))`);
    recordTiming({phase:'fresh authenticated launch request',width,path,elapsedMs:Date.now()-requestStarted,status:refusal.status});
    assert.equal(refusal.status,409,path+': real authenticated dialog request is gated before missing-folder checks/spawn');assert.equal(refusal.body.code,'launch_disclosure_required');
   }

   await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
   await waitFor(`!!document.getElementById('launch-disclosure-banner')`,'real unseen server record shows the banner');
   assert.deepEqual(await ev(`(()=>{const b=document.getElementById('launch-disclosure-banner'),s=b.querySelector('summary'),read=[...b.querySelectorAll('button')].find(x=>x.textContent.trim()==="I've read this"),dismiss=b.querySelector('.launch-disclosure-dismiss');return {expanded:s.getAttribute('aria-expanded'),summary:s.querySelector('.launch-disclosure-summary-text')?.textContent,controls:!!document.getElementById(s.getAttribute('aria-controls')),readHidden:!read.checkVisibility(),dismissVisible:dismiss.checkVisibility(),bounded:b.getBoundingClientRect().height<=innerHeight/4+1}})()`),{expanded:'false',summary:'Agents default to auto mode.',controls:true,readHidden:true,dismissVisible:true,bounded:true},'collapsed summary uses the Operator-approved default-auto wording, keeps the acknowledgement inside its body, and exposes Dismiss');
   await waitFor(`document.getElementById('notice-live')?.textContent.trim()==='Agents default to auto mode.'`,'screen-reader announcement matches the collapsed summary',10000);
   await snapshot('closed',width);
   dismissChecks.push(await ev(`(()=>{const b=document.getElementById('launch-disclosure-banner'),s=b.querySelector('summary'),d=b.querySelector('.launch-disclosure-dismiss'),text=s.querySelector('.launch-disclosure-summary-text'),r=d.getBoundingClientRect(),br=b.getBoundingClientRect(),tr=text.getBoundingClientRect();return {width:${width},label:d.getAttribute('aria-label'),height:r.height,widthPx:r.width,inside:r.left>=br.left&&r.right<=br.right&&r.top>=br.top&&r.bottom<=br.bottom,clear:r.right<=tr.left||r.left>=tr.right||r.bottom<=tr.top||r.top>=tr.bottom,collapsed:!b.querySelector('details').open}})()`));
   await ev(`(()=>{const real=window.fetch;window.__dismissProbe={real,calls:0,fail:true};window.fetch=(input,options={})=>{if(new URL(String(input),location.href).pathname==='/api/launch-disclosure/ack'){window.__dismissProbe.calls++;if(window.__dismissProbe.fail)return Promise.resolve(Response.json({error:'owner_only'},{status:403}));}return real(input,options)};document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click();return true})()`);
   await waitFor(`window.__dismissProbe.calls===1`,'collapsed Dismiss submits the owner acknowledgement');
   await waitFor(`!document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss')?.disabled`,'failed Dismiss write restores the action');
   await ev(require('./helpers/wait').framesJs(2));
   assert.deepEqual(await ev(`(()=>{const b=document.getElementById('launch-disclosure-banner');return {visible:!!b,collapsed:!b.querySelector('details').open,seen:window.__dismissProbe.calls>0,dismissDisabled:b.querySelector('.launch-disclosure-dismiss').disabled,error:document.querySelector('#toast-host .toast.error .toast-message')?.textContent.includes('Could not record that you have read this')}})()`),{visible:true,collapsed:true,seen:true,dismissDisabled:false,error:true},`${width}: refused acknowledgement leaves the notice collapsed, visible, and reports the error`);
   await ev(`document.querySelectorAll('#toast-host .toast').forEach(t=>t.remove());true`); // the failed write's error toast (asserted above) is on screen for seconds and, on a phone at 200% text, sits over the notice's acknowledgement: the keyboard check below is about the notice, so it starts with the toast gone (#14786)
   await ev(`window.__dismissProbe.fail=false;document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click();true`);
   await waitFor(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen===true)`,'collapsed Dismiss acknowledgement persisted on the real server');
   await ev(`window.fetch=window.__dismissProbe.real;fetch('/api/launch-disclosure/ack',{method:'DELETE'}).then(r=>r.ok)`);
   await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
   await waitFor(`!!document.getElementById('launch-disclosure-banner')`,'dismiss test resets the unseen notice for keyboard checks');
   await ev(`(()=>{[...document.querySelectorAll('#launch-disclosure-banner button')].find(b=>b.textContent.trim()==="I've read this").click();return true})()`);
   assert.equal(await ev(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen)`),false,'a closed notice cannot acknowledge even through a synthetic button click');
   await ev(`document.querySelector('#launch-disclosure-banner summary').focus();true`);
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
   await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   await waitFor(`document.querySelector('#launch-disclosure-banner summary').getAttribute('aria-expanded')==='true'`,'keyboard opens the full disclosure',5000,`({focus:document.activeElement?.outerHTML,open:document.querySelector('#launch-disclosure-banner details')?.open,inert:!!document.querySelector('#launch-disclosure-banner')?.closest('[inert]')})`);
   assert.equal(await ev(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen)`),false,'expansion never acknowledges');
   await snapshot('open',width);
   if(width===390)await ev(`document.documentElement.style.fontSize='32px';true`);
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   await client.Input.dispatchKeyEvent({type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   await waitFor(`document.activeElement===document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss')`,'Tab reaches collapsed-row Dismiss');
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   await client.Input.dispatchKeyEvent({type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   await waitFor(`document.activeElement===[...document.querySelectorAll('#launch-disclosure-banner button')].find(b=>b.textContent.trim()==="I've read this")`,'Tab reaches the expanded acknowledgement');
   const ackPoint=()=>ev(`(()=>{const b=document.getElementById('launch-disclosure-banner').getBoundingClientRect(),a=[...document.querySelectorAll('#launch-disclosure-banner button')].find(x=>x.textContent.trim()==="I've read this"),r=a.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,inside:r.top>=b.top&&r.bottom<=b.bottom&&y>=0&&y<innerHeight&&a.contains(document.elementFromPoint(x,y))}})()`);
   assert.equal((await ackPoint()).inside,true,`${width}: Tab scrolls the acknowledgement into the bounded notice, including 200% text on phone`);
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
   await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   await waitFor(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen===true)`,'keyboard acknowledgement persisted on the real server');
   if(width===390){
    await Emulation.setTouchEmulationEnabled({enabled:true});
    await ev(`fetch('/api/launch-disclosure/ack',{method:'DELETE'}).then(r=>r.ok)`);
    await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
    const point=await ev(`(()=>{const r=document.getElementById('launch-disclosure-banner').getBoundingClientRect();return{x:r.left+30,y:r.top+20}})()`);
    await touchTap(client, { ...point });
    await waitFor(`document.querySelector('#launch-disclosure-banner summary').getAttribute('aria-expanded')==='true'`,'touch opens notice at 390/200%');
    let ack=await ackPoint();
    for(let i=0;i<16&&!ack.inside;i++){
     const origin=await ev(`(()=>{const r=document.getElementById('launch-disclosure-banner').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height*0.8}})()`);
     await touchScroll(client, { ...origin,yDistance:-160 });
     ack=await ackPoint();
    }
    assert.equal(ack.inside,true,'touch scrolling reaches the real acknowledgement at 390/200%');
    assert.equal(await ev(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen)`),false,'touch expansion and scrolling do not acknowledge');
    await touchTap(client, { x:ack.x,y:ack.y });
    await waitFor(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen===true)`,'real touch acknowledgement persisted');
    await ev(`document.documentElement.style.fontSize='';true`);
   }
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
    assert.ok(await ev(`(()=>{const s=document.querySelector('#role-default-probe [data-role-limit-status]');return s?.getAttribute('role')==='status'&&s?.getAttribute('aria-live')==='polite'&&s.textContent.startsWith('Role limits applied: ')&&s.getBoundingClientRect().height>0})()`),role+' visibly confirms and announces the applied tools');
    const config=await ev(`import((window.__coralStatic||'/static/')+'agent_config_form.js').then(m=>m.getAgentConfig('role-default-probe'))`);
    assert.equal(config.name,role);assert.equal(config.permissionMode,'auto','narrowing tools preserves the selected mode');if(role!=='Terminal')assert.ok(config.prompt.length>0,'role instructions survive');
    assert.deepEqual(config.capabilities.allow.slice().sort(),await ev('window.__expectedRoleLimits'),role+' applies its exact saved tool choices');
   }
   await ev(`document.getElementById('role-default-probe').remove();true`);
   await openNewTeam(ev,waitFor);
   await waitFor(`!!document.getElementById('team-permission-mode')`,'team permission field');
   assert.equal(await ev(`document.getElementById('team-permission-mode').value`),'auto','new Claude team follows shipped default');
   const team=T(ev,waitFor);await team.to(3,{name:'permissions-probe',folder:'/work/payments-app'});
   await ev(`(()=>{const real=window.fetch;window.__teamDefaultPosts=[];window.fetch=(input,options={})=>{if(new URL(String(input),location.href).pathname==='/api/sessions/launch-team'){window.__teamFirstPostAt=performance.now();window.__teamDefaultPosts.push(JSON.parse(options.body));if(window.__teamDefaultPosts.length===1)return new Promise(resolve=>{window.__releaseTeamLaunch=()=>resolve(Response.json({code:'launch_disclosure_required',disclosure:{id:'timing-disclosure',text:'Full permissions allow commands and file changes.',seen:false}},{status:409}))});return Promise.resolve(Response.json({error:'Test stopped before spawning'},{status:403}));}return real(input,options)};return true})()`);
   const started=await ev(`(()=>{const b=document.getElementById('launch-team-go');const at=performance.now();window.__teamClickAt=at;b.click();return {disabled:b.disabled,busy:b.getAttribute('aria-busy'),words:b.textContent,elapsed:performance.now()-at}})()`);
   assert.ok(started.disabled&&started.busy==='true'&&/Preparing|Launching/.test(started.words)&&started.elapsed<1000,`${width}: first click immediately shows launch progress before any asynchronous preparation: ${JSON.stringify(started)}`);
   await waitFor(`window.__teamDefaultPosts.length===1`,'new team launch payload');
   recordTiming({phase:'click to first POST',width,elapsedMs:await ev('window.__teamFirstPostAt-window.__teamClickAt')});
   recordTiming({phase:'loaded launch resources',...(await ev(`({width:innerWidth,resources:performance.getEntriesByType('resource').filter(r=>/launch_skills|skills.css|launch_disclosure/.test(r.name)).map(r=>({name:r.name.split('/').pop(),durationMs:r.duration,startMs:r.startTime}))})`))});
   await ev(`window.launchTeam();true`);
   await ev(require('./helpers/wait').framesJs(4));
   assert.equal(await ev('window.__teamDefaultPosts.length'),1,'a second click/call while waiting cannot issue another launch');
   assert.equal(await ev(`document.getElementById('launch-team-go').getAttribute('aria-busy')`),'true','progress remains while the first response is held');
   await ev(`window.__disclosureReleasedAt=performance.now();window.__releaseTeamLaunch();true`);
   await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length>0&&document.getElementById('confirm-modal-message')?.textContent==='Full permissions allow commands and file changes.'`,'permissions confirmation promptly after first response',1000);
   recordTiming({phase:'409 response to confirmation',width,elapsedMs:await ev('performance.now()-window.__disclosureReleasedAt')});
   assert.ok(await ev(`performance.now()-window.__disclosureReleasedAt<1000`),'confirmation opens within one second of the server answer');
   await ev(`[...document.querySelectorAll('#confirm-modal button')].find(b=>b.textContent.trim()==='Cancel').click();true`);
   await waitFor(`!document.getElementById('launch-team-go').disabled&&!document.getElementById('launch-team-go').hasAttribute('aria-busy')`,'cancellation restores the launch button');
   assert.equal(await ev('window.__teamDefaultPosts.length'),1,'cancel starts nothing and retries nothing');
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
   await ev(`(async()=>{const S=window.__coralStatic||'/static/';(await import(S+'launch_core.js')).hideLaunchModal();const real=window.fetch;window.__disclosure={id:'full-permissions-1',text:'Agents default to auto mode. <b>Change the default in Settings.</b>',seen:false};window.__launchAudit={launch:[],ack:[],failAck:false};window.fetch=(input,options={})=>{const path=new URL(String(input),location.href).pathname;const json=(data,status=200)=>Promise.resolve(Response.json(data,{status}));if(path==='/api/launch-disclosure')return json(window.__disclosure);if(path==='/api/launch-disclosure/ack'){window.__launchAudit.ack.push(JSON.parse(options.body));if(window.__launchAudit.failAck)return json({error:'owner_only'},403);window.__disclosure.seen=true;return json({id:window.__disclosure.id,seen:true});}if(path==='/api/sessions/launch'||path==='/api/sessions/launch-team'){window.__launchAudit.launch.push({path,body:JSON.parse(options.body)});return window.__disclosure.seen?json({session_id:'new-agent',name:'new-agent',permission_mode:'auto'}):json({code:'launch_disclosure_required',disclosure:window.__disclosure},409);}return real(input,options)};await(await import(S+'launch_disclosure.js')).refreshLaunchDisclosure();return true;})()`);
   await waitFor(`document.getElementById('launch-disclosure-banner')?.querySelector('.launch-disclosure-summary-text')?.textContent==='Agents default to auto mode.'`,'unseen disclosure summary uses the approved default-auto wording');
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
  for(const x of dismissChecks){assert.equal(x.label,'Dismiss, I have read this',`${x.width}: Dismiss has an explicit accessible name`);assert.ok(x.inside&&x.clear&&x.widthPx>=44&&x.height>=44&&x.collapsed,`${x.width}: collapsed summary Dismiss is a non-overlapping 44 px target: ${JSON.stringify(x)}`);}
  console.log('PASS shipped full presets, visible role limits and explicit team Default at desktop/phone');
 }finally{try{await guard.restore()}finally{await client.close()}}
})().catch(e=>{console.error(e);process.exitCode=1});
