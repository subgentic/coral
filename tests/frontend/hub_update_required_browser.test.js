// #20440: the Hub's explicit minimum version reaches each page, with its source.
const assert=require('node:assert/strict');
const { showTasksTab } = require('./helpers/tasks_tab.js');
const fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {setupHubWorld,BASE}=require('./helpers/hub_world');
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD}=await connect();const failures=[];
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await setupHubWorld({client,Page,Emulation,width:1280,height:844,mobile:false,inbox:'native',needs:true,bootExtra:'"tasks":"native","saved":"native"'});
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{
   class Quiet extends EventTarget{constructor(){super();this.readyState=0;}send(){}close(){this.readyState=3;}}Object.assign(Quiet,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});window.WebSocket=Quiet;
   const real=window.fetch;window.__upgradeReads=[];
   for(const c of window.__computers){c.version='2.1.3';c.owner=true;}
   window.fetch=(u,o)=>{const p=new URL(String(u),location.href);if(p.pathname==='/api/account')return Promise.resolve(Response.json({artifacts_tab:true,artifacts_frame:true,needs_native:true,tasks_native:true,saved_native:true}));if(p.pathname.startsWith('/api/remote/')&&(!window.__refuseServer||p.pathname.startsWith('/api/remote/'+window.__refuseServer+'/'))&&window.__refusePath&&p.pathname.includes(window.__refusePath)){
    window.__upgradeReads.push(p.pathname);return Promise.resolve(Response.json(window.__refuseBody||{error:'coral_too_old',min:'2.1.4'},{status:window.__refuseStatus||409}));
   }return real(u,o);};
  })()`});
  const pages=[
   ['skills','skills','/api/skills','#skills-view'],
   ['tasks','hub-inbox','/api/board/tasks','#group-table-view','tasks'],
   ['saved','hub-inbox','/api/saved','#group-table-view','saved'],
   ['needs','hub-inbox','/api/operator-asks','#group-table-view','needs'],
   ['goals','hub-inbox','/api/goals','#group-table-view','goals'],
   ['chats','hub-inbox','/api/sessions/history','#group-table-view','chats'],
   ['artifacts','hub-inbox','/api/team-artifacts','#group-table-view','artifacts'],
   ['analytics','tokens','/api/token-usage/','#cost-page'],
   ['automations','automations','/api/scheduled/jobs','#scheduler-detail']
  ];
  for(const width of [1280,390])for(const [name,tab,path,selector,folder] of pages){
   await Emulation.setDeviceMetricsOverride({width,height:844,deviceScaleFactor:1,mobile:width===390});
   await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await showTasksTab(Page); // the Tasks tab is shown again for this suite (#22109)
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();
   await waitFor(`typeof window.switchNavTab==='function'&&import((window.__coralStatic||'/static/')+'state.js').then(m=>m.state.serversKnown)`, 'Hub inventory',15000);
   await ev(`window.__refusePath=${JSON.stringify(path)};window.switchNavTab(${JSON.stringify(tab)});true`);
   if(folder)await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab(${JSON.stringify(folder)})).then(()=>true)`);
   if(name==='needs')await ev(`import((window.__coralStatic||'/static/')+'operator_asks.js').then(m=>m.refreshOperatorAsks(true))`);
   if(name==='automations')await ev(`import((window.__coralStatic||'/static/')+'automations_cloud.js').then(m=>m.openAutomationsRoute({folder:'jobs'}))`);
   if(name==='analytics')await ev(`import((window.__coralStatic||'/static/')+'analytics_views.js').then(m=>m.selectView('overview'))`);
   try{
    await waitFor(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(name==='automations'?'2.1.4':'Update Coral on Laptop to 2.1.4 to see this')})`, name+' update reason',7000);
    if(name==='skills')assert.equal(await ev(`document.querySelector('#skills-view').textContent.includes('No skills yet')`),false,'a refused skill read is not an empty list');
    if(name==='goals')assert.equal(await ev(`document.querySelector('#group-table-view').textContent.split('Update Coral on Laptop to 2.1.4 to see this').length-1`),1,'Goals says its update instruction once');
    if(['tasks','saved'].includes(name))assert.equal(await ev(`document.querySelector('#group-table-view').textContent.includes('this. Update Coral')`),true,name+' separates the computer instructions');
    if(name==='saved')assert.equal(await ev(`document.querySelector('#group-table-view').textContent.includes('Save a message from a chat')`),false,'Saved does not append an empty-list hint to a refused read');
    assert.equal(await ev(`window.__upgradeReads.length>0`),true,name+' made the refused read');
    assert.equal(await ev(`document.querySelector(${JSON.stringify(selector)}).textContent.includes('HTTP 409')`),false,name+' bare HTTP 409');
   }catch(e){failures.push(width+' '+name+': '+e.message+'; text='+await ev(`document.querySelector(${JSON.stringify(selector)})?.textContent.slice(0,1000)`));}
   if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/'+width+'-'+name+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
  }
  assert.deepEqual(failures,[]);
  // Main does not yet expose Hub Activity navigation (#20394 is held). Exercise
  // the production Activity reader/spec directly, as the Orchestrator requested.
  await ev(`(async()=>{window.__refusePath='/api/activity';const m=await import((window.__coralStatic||'/static/')+'inbox_activity.js');m.forget();await m.refresh();const host=document.createElement('section');host.id='update-activity-component';const spec=m.spec({},()=>{});host.append(Object.assign(document.createElement('p'),{textContent:spec.empty.line}),spec.node());document.body.append(host);return true;})()`);
  assert.match(await ev(`document.querySelector('#update-activity-component').textContent`),/Update Coral on Laptop to 2\.1\.4 to see this/);
  // The old Chats transcript must also be replaced by the reason from its source.
  await ev(`(async()=>{window.__refusePath='/api/sessions/history/same-chat';const m=await import((window.__coralStatic||'/static/')+'history_source.js');m.setHistorySource('m1');return (await import((window.__coralStatic||'/static/')+'sessions.js')).selectHistorySession('same-chat',null,{session_id:'same-chat',server:'m1'});})()`);
  assert.match(await ev(`document.querySelector('#history-messages').textContent`),/Update Coral on Laptop to 2\.1\.4 to see this/);
  for(const [suffix,method,selector]of [['events','loadHistoryEvents','#history-events-list'],['tasks','loadHistoryTasks','#history-task-list'],['agent-notes','loadHistoryAgentNotes','#history-note-list']]){
   await ev(`(async()=>{window.__refusePath='/api/sessions/history/same-chat/'+${JSON.stringify(suffix)};const m=await import((window.__coralStatic||'/static/')+'history_tabs.js');return m[${JSON.stringify(method)}]('same-chat');})()`);
   assert.match(await ev(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`),/Update Coral on Laptop to 2\.1\.4 to see this/,'history '+suffix);
  }
  await ev(`(async()=>{window.__refusePath='/api/resources';const m=await import((window.__coralStatic||'/static/')+'automations_queue.js');m.setQueueMachine('m1');await m.refreshQueue();const host=document.createElement('section');host.id='update-queue';host.textContent=m.queueTable([],false).empty.line;document.body.append(host);return true;})()`);
  assert.match(await ev(`document.querySelector('#update-queue').textContent`),/Update Coral on Laptop to 2\.1\.4 to see this/);
  assert.match(await ev(`import((window.__coralStatic||'/static/')+'automations_queue.js').then(m=>m.queueTable([{key:'cached'}],false).note)`),/Update Coral on Laptop to 2\.1\.4 to see this/,'cached queue keeps its refusal visible');
  await ev(`(async()=>{window.__refusePath='/api/sessions/history/same-chat/notes';return (await import((window.__coralStatic||'/static/')+'notes.js')).loadSessionNotes('same-chat');})()`);
  assert.match(await ev(`document.querySelector('#notes-rendered').textContent`),/Update Coral on Laptop to 2\.1\.4 to see this/,'history notes');
  const switched=await ev(`(async()=>{window.__refusePath='';const source=await import((window.__coralStatic||'/static/')+'history_source.js'),api=await import((window.__coralStatic||'/static/')+'api.js');source.setHistorySource('m1');const real=window.fetch;let calls=0;window.fetch=(u,o)=>{if(String(u).includes('/api/sessions/history/same-chat'))calls++;return real(u,o);};try{const pending=api.loadHistoryMessages('same-chat',{throwOnError:true});source.setHistorySource('m2');await pending;return calls;}finally{window.fetch=real;source.setHistorySource('m1');}})()`);
  assert.equal(switched,0,'a computer switch during lazy reader loading cancels the stale read');
  // Live-agent panels and the team's readers use their real rendering functions.
  await ev(`(async()=>{window.__refusePath='';return (await import((window.__coralStatic||'/static/')+'sessions.js')).selectLiveSession('hub-agent-0','claude','hub-agent-0','m1');})()`);
  const panels=[
   ['info','/info','info_tab.js','showInfoTab()','#info-tab-note'],
   ['agent notes','/notes','agent_notes.js',"loadAgentNotes('hub-agent-0','hub-agent-0')",'#note-md-rendered'],
   ['agent events','/events','agentic_state.js',"loadAgentEvents('hub-agent-0','hub-agent-0')",'#agentic-state-events'],
   ['agent files','/files','changed_files.js',"loadChangedFiles('hub-agent-0','hub-agent-0')",'#changed-files-list'],
   ['agent branches','/branches','branches_tab.js','loadBranches()','#agentic-panel-branches']
  ];
  for(const [name,path,file,call,selector]of panels){
   await ev(`(async()=>{window.__refusePath='/api/sessions/live/hub-agent-0'+${JSON.stringify(path)};document.querySelector('#agentic-panel-branches')?.classList.add('active');const m=await import((window.__coralStatic||'/static/')+${JSON.stringify(file)});return m.${call};})()`);
   assert.match(await ev(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`),/Update Coral on Laptop to 2\.1\.4 to see this/,name);
  }
  const staleBranches=await ev(`(async()=>{const {state}=await import((window.__coralStatic||'/static/')+'state.js'),m=await import((window.__coralStatic||'/static/')+'branches_tab.js');const prior=state.currentSession,real=window.fetch,panel=document.querySelector('#agentic-panel-branches');let release;state.currentSession={...prior,type:'live',name:'hub-agent-0',session_id:'hub-agent-0',server:'m1'};panel.classList.add('active');panel.textContent='Desktop selection';window.fetch=(u,o)=>String(u).includes('/branches?')?new Promise(r=>release=r):real(u,o);try{const pending=m.loadBranches();state.currentSession={...state.currentSession,server:'m2'};release(Response.json({error:'coral_too_old',min:'2.1.4'},{status:409}));await pending;return panel.textContent;}finally{window.fetch=real;state.currentSession=prior;}})()`);
  assert.equal(staleBranches,'Desktop selection','same session id on another computer cannot receive the stale update error');
  await ev(`(async()=>{window.__refusePath='/api/board/same-team/goals';const host=document.createElement('section');host.id='update-team-goals';document.body.append(host);(await import((window.__coralStatic||'/static/')+'goals_view.js')).showGoals(host,'@m1/same-team');return true;})()`);
  await waitFor(`document.querySelector('#update-team-goals')?.textContent.includes('Update Coral on Laptop to 2.1.4 to see this')`,'team goals update');
  await ev(`(async()=>{window.__refusePath='/api/board/';const {state}=await import((window.__coralStatic||'/static/')+'state.js');state.currentSession=null;state.selectedTeam='@m1/same-team';return (await import((window.__coralStatic||'/static/')+'task_list.js')).loadBoardTasks('@m1/same-team');})()`);
  assert.match(await ev(`document.querySelector('#board-task-list').textContent`),/Update Coral on Laptop to 2\.1\.4 to see this/,'team tasks');
  await ev(`(async()=>{window.__refusePath='/api/board/same-team/messages/all';const host=document.createElement('section');host.id='update-team-messages';document.body.append(host);(await import((window.__coralStatic||'/static/')+'message_board.js')).showBoardInPage('@m1/same-team',host);return true;})()`);
  await waitFor(`document.querySelector('#update-team-messages')?.textContent.includes('Update Coral on Laptop to 2.1.4 to see this')`,'team messages update');
  await ev(`(async()=>{window.__refusePath='/api/board/projects';(await import((window.__coralStatic||'/static/')+'message_board.js')).showMessageBoardProjects();return true;})()`);
  await waitFor(`document.querySelector('#mb-project-list')?.textContent.includes('Update Coral on Laptop to 2.1.4 to see this')`,'board list update');
  for(const [method,args,path]of [['fetchAllBoardMessages',['@m1/same-team'],'/api/board/same-team/messages/all'],['fetchAllLiveChat',[{name:'hub-agent-0',session_id:'hub-agent-0',server:'m1'}],'/api/sessions/live/hub-agent-0/chat'],['fetchAllHistory',['same-chat','m1'],'/api/sessions/history/same-chat']]){
   const text=await ev(`(async()=>{window.__refusePath=${JSON.stringify(path)};try{await (await import((window.__coralStatic||'/static/')+'board_fetch.js'))[${JSON.stringify(method)}](...${JSON.stringify(args)});return 'did not refuse';}catch(e){return e.message;}})()`);
   assert.match(text,/Update Coral on Laptop to 2\.1\.4 to see this/,method);
  }
  await ev(`(async()=>{window.__refusePath='/api/teams/detail/same-team/knowledge';const host=document.createElement('section');host.id='update-team-knowledge';document.body.append(host);(await import((window.__coralStatic||'/static/')+'team_knowledge_page.js')).showKnowledge(host,'@m1/same-team');return true;})()`);
  await waitFor(`document.querySelector('#update-team-knowledge')?.textContent.includes('Update Coral on Laptop to 2.1.4 to see this')`,'team knowledge update');
  await ev(`(async()=>{window.__refusePath='/api/board/same-team/working-mode';const host=document.createElement('section');host.id='update-team-settings';document.body.append(host);await (await import((window.__coralStatic||'/static/')+'team_settings_page.js')).showTeamSettingsPage('@m1/same-team',{page:host});return true;})()`);
  await waitFor(`document.querySelector('#update-team-settings')?.textContent.includes('Update Coral on Laptop to 2.1.4 to see this')`,'team settings update');
  await ev(`(async()=>{window.__refusePath='/api/board/projects';let host=document.querySelector('#settings-inbox-teams');if(!host){host=document.createElement('section');host.id='settings-inbox-teams';document.body.append(host);}return (await import((window.__coralStatic||'/static/')+'settings_inbox.js')).drawInboxTeams('');})()`);
  assert.match(await ev(`document.querySelector('#settings-inbox-teams').textContent`),/Update Coral on Laptop to 2\.1\.4 to see this/,'settings team read');
  await ev(`import((window.__coralStatic||'/static/')+'home_goal.js').then(m=>m.startGoalFromHome())`);
  assert.match(await ev(`document.querySelector('#toast-host .toast:last-child .toast-message')?.textContent||''`),/Update Coral on Laptop to 2\.1\.4 to see this/,'New goal team read');
  const partial=await ev(`(async()=>{window.__refusePath='/api/goals';window.__refuseServer='m1';const m=await import((window.__coralStatic||'/static/')+'inbox_coral.js');const [rows]=await Promise.all([m.listInboxGoals(),m.coralInboxAdapter.listTasks()]);window.__refuseServer='';return {other:rows.some(g=>g.server==='m2'),note:m.goalsUpdateNote()};})()`);
  assert.equal(partial.other,true);assert.match(partial.note,/Update Coral on Laptop to 2\.1\.4 to see this/,'partial and concurrent reads keep the refused source');
  const jsonError=await ev(`(async()=>{window.__refusePath='/api/goals';try{await (await import((window.__coralStatic||'/static/')+'request_json.js')).requestJson('GET','/api/remote/m1/api/goals');return null;}catch(e){return {message:e.message,code:e.code,status:e.status,min:e.data?.min};}})()`);
  assert.deepEqual(jsonError,{message:'Update Coral on Laptop to 2.1.4 to see this',code:'coral_too_old',status:409,min:'2.1.4'});
  // A valid label is text, even when it resembles markup; a malformed minimum
  // remains the existing error and a subsequent successful read clears the note.
  await ev(`(async()=>{window.__refusePath='/api/skills';const {state}=await import((window.__coralStatic||'/static/')+'state.js');state.servers.find(s=>s.id==='m1').label='Laptop <img src=x onerror=window.__updatePwn=1>';return (await import((window.__coralStatic||'/static/')+'skills_tab.js')).showSkillsTab();})()`);
  assert.equal(await ev(`document.querySelector('#skills-view').textContent.includes('Laptop <img src=x onerror=window.__updatePwn=1>')`),true);
  assert.equal(await ev(`!!document.querySelector('#skills-view img')||!!window.__updatePwn`),false);
  await ev(`window.__refuseBody={error:'coral_too_old',min:'<img>'};import((window.__coralStatic||'/static/')+'skills_tab.js').then(m=>m.showSkillsTab())`);
  assert.equal(await ev(`document.querySelector('#skills-view').textContent.includes('Update Coral on')`),false);
  await ev(`window.__refusePath='';import((window.__coralStatic||'/static/')+'skills_tab.js').then(m=>m.showSkillsTab())`);
  assert.equal(await ev(`document.querySelector('#skills-view').textContent.includes('Update Coral on')`),false);
  assert.equal(await ev(`document.querySelector('#skills-view').textContent.includes('No skills yet')`),true,'a successful empty read keeps its empty state');
  assert.deepEqual(failures,[]);
  // Same parser for every page. Negative controls must never tell someone to update.
  const validation=await ev(`import((window.__coralStatic||'/static/')+'computer_update_error.js').then(m=>({valid:m.requiredCoralVersion(409,{error:'coral_too_old',min:'2.1.4'}),bad:[...['v2.1.4','2.1',' 2.1.4','2.1.4\\n','<img>','12345678901234567.1.1'].map(min=>[409,{error:'coral_too_old',min}]),[409,{error:'coral_too_old',min:'2.1.4',extra:true}],[403,{error:'coral_too_old',min:'2.1.4'}],[409,{error:'conflict',min:'2.1.4'}]].map(([status,body])=>m.requiredCoralVersion(status,body))}))`);
  assert.equal(validation.valid,'2.1.4');assert.deepEqual(validation.bad,Array(validation.bad.length).fill(''));
  assert.deepEqual(failures,[]);console.log('PASS Hub update-required: per-page version messages at desktop and phone, strict refusal validation');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
