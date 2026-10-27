// #8708: every Inbox folder carries origin, sorting and a Server filter in hub mode.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {setTheme}=require('./helpers/contrast');
const BASE=require('./test_base').BASE;
const fs=require('node:fs'),path=require('node:path');
const folders=['goals','tasks','chats-group','needs','saved','chats','artifacts'];
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const failures=[];
 const open=async folder=>{
  await ev(`window.switchNavTab('hub-inbox');true`);
  await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('${folder}')).then(()=>true)`);
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();
   await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
   await ev(`(async()=>{
    const {state}=await import((window.__coralStatic||'/static/')+'state.js');window.__serverState=state;
    state.hub=true;state.servers=[{id:'local',label:'Hub',status:'online'},{id:'box-2',label:'Remote box',name:'Remote box',status:'online'}];
    for(const key of Object.keys(localStorage))if(key.includes('inbox')||key.includes('saved-filter'))localStorage.removeItem(key);
    window.__m.add('Local agent','A',1,{sleeping:false,board_project:'same-team',session_id:'local-agent'});
    window.__m.add('Remote agent','B',1,{sleeping:false,board_project:'same-team',session_id:'remote-agent',server:'box-2'});
    state.liveSessions=state.liveSessions.map(s=>({...s,waiting_for_input:true,waiting_kind:'question',waiting_since:new Date().toISOString()}));
    const real=window.fetch;window.__serverReads=[];
    window.fetch=(url,opts={})=>{
     const u=new URL(String(url),location.origin),remote=u.pathname.startsWith('/api/remote/box-2/'),p=remote?u.pathname.slice('/api/remote/box-2'.length):u.pathname;
     window.__serverReads.push(u.pathname);const label=remote?'Remote':'Local',now=new Date().toISOString();
     const json=body=>Promise.resolve(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}));
     if(p==='/api/goals')return json({goals:[{id:1,board_id:'same-team',title:label+' goal',state:'active',rollup:{queued:1}}]});
     if(p==='/api/board/tasks')return json({tasks:[{id:1,board_id:'same-team',board_label:label+' team',title:label+' task',status:'pending',priority:'medium',assigned_to:'Operator'}]});
     if(p==='/api/saved')return json({items:[{id:1,kind:'board',ref:'same-team',key:'1',title:label+' saved message',snippet:label+' bookmark',saved_at:now,team:'same-team'}],open:1,done:0});
     if(p==='/api/sessions/history/counts')return json({all:1,group:1,starred:0,archived:0,notes:0,active:0,tags:[],by_agent_type:{claude:1}});
     if(p==='/api/sessions/history'){
      const group=u.searchParams.get('type')==='group';
      return json({sessions:[{session_id:group?'board:same-team':'same-chat',type:group?'group':'agent',title:label+(group?' board':' chat'),display_name:label+' agent',agent_type:'claude',summary:label+' conversation',last_timestamp:now,duration_sec:60}],total:1});
     }
     if(p==='/api/sessions/history/same-chat')return json({messages:[],start:0,total:0,agent_type:'claude'});
     if(p.startsWith('/api/sessions/history/same-chat/'))return json({});
     if(p==='/api/team-artifacts'){
      const id=(remote?'b':'a').repeat(64);return json({artifacts:[{id,name:label+' report.txt',media_type:'text/plain',size:25,created_at:now,board_id:'same-team',team:label+' team',task_id:0,source:'upload',available:true,uri:'coral://artifacts/'+id,produced_by:label+' agent'}],all:1,total:1,has_more:false,teams:[{board_id:'same-team',team:label+' team',all:1}]});
     }
     if(remote)return json({});return real(url,opts);
    };(await import((window.__coralStatic||'/static/')+'inbox_tab.js')).updateInboxTab();return true;
   })()`);
   for(const folder of folders){try{
    await open(folder);
    // Artifacts (#9408): a Computer column of its own (th data-key server) beside the plain Team, one line each; the row's hover and preview name it where a narrow list drops both; the Server filter stays in the panel
    const artifacts=folder==='artifacts',col='server',is=t=>`e.textContent==='${t}'`;
    await waitFor(`!!document.querySelector('#group-table-view th[data-key="server"]')`,'Server column in '+folder,5000);
    if(artifacts)assert.ok(await ev(`[...document.querySelectorAll('#group-table-view th[data-key="server"]')].every(h=>h.textContent.trim().startsWith('Computer'))&&[...document.querySelectorAll('#group-table-view td[data-key="team"]')].every(e=>!/This computer|Remote box/.test(e.textContent))`),'the column is called Computer and Team is the plain team name');
    if(['tasks','goals','needs'].includes(folder))assert.ok(await ev(`(()=>{const keys=[...document.querySelectorAll('#group-table-view th[data-key]')].map(e=>e.dataset.key);return keys.indexOf('server')>0&&keys.indexOf('server')===keys.indexOf('team')-1;})()`),'Server immediately precedes Team');
    if(folder.startsWith('chats'))assert.ok(await ev(`(()=>{const keys=[...document.querySelectorAll('#group-table-view th[data-key]')].map(e=>e.dataset.key);return keys.indexOf('when')>=0&&keys.indexOf('server')===keys.indexOf('when')+1;})()`),'Server follows When (#8961: one line a chat, Title, Agent, When, then Server; Server and then Agent drop first)');
    const cells=`[...document.querySelectorAll('#group-table-view td[data-key="${col}"]')]`;
    await waitFor(`${cells}.some(e=>${is('This computer')})&&${cells}.some(e=>${is('Remote box')})`,'both origins in '+folder,8000);
    // one line a row on a phone (#8961, #8981, #8931): a chat, a Saved item and an artifact row drop their Server or Team column, and the computer stays on the row's hover (the title of its name); Needs you, Goals and Tasks keep Server
    const lean=artifacts||folder.startsWith('chats')||folder==='saved';
    if(width===390&&!lean)assert.ok(await ev(`${cells}.every(e=>e.getClientRects().length>0)`),'Server visible on phone');
    if(width===390&&lean)assert.ok(await ev(`${cells}.every(e=>e.getClientRects().length===0)&&[...document.querySelectorAll('#group-table-view tbody .dt-primary')].some(b=>/This computer|Remote box/.test(b.title))`),folder+': the column is dropped on a phone and the computer is on the row\'s hover');
    assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow');
    const sortable=await ev(`(() => {const s=[...document.querySelectorAll('#group-table-view .dt-sortbar select')].find(s=>[...s.options].some(o=>o.value==='server'));if(s&&s.getClientRects().length){s.value='server';s.dispatchEvent(new Event('change',{bubbles:true}));return true;}const h=document.querySelector('#group-table-view th[data-key="server"]');const b=h?.querySelector('button');if(b){b.click();return true;}return false;})()`);
    if(!artifacts&&!folder.startsWith('chats'))assert.ok(sortable,'Server sort control in '+folder); // a chat row is one line with no sort controls (#8961): its order is the newest first
    if(!artifacts&&!folder.startsWith('chats'))await waitFor(`(()=>{const values=${cells}.map(e=>e.textContent);return values.length>1&&values.every((v,i)=>!i||values[i-1].localeCompare(v)<=0);})()`,'Server ascending order in '+folder);
    const shotDir=process.env.CORAL_SCREENSHOT_DIR||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'out'));
    if(shotDir){fs.mkdirSync(shotDir,{recursive:true});for(const theme of ['light','dark']){await setTheme(ev,theme);fs.writeFileSync(path.join(shotDir,`inbox-server-${folder}-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
    await ev(`document.querySelector('#group-table-view .list-bar-toggle').click();true`);
    const select=`[...document.querySelectorAll('.list-bar-field')].find(e=>e.querySelector('.list-bar-field-label')?.textContent.trim()==='Server')?.querySelector('select')`;
    await waitFor(`!!(${select})&&(${select}).getClientRects().length>0`,'Server filter in '+folder);
    if(shotDir&&['tasks','goals'].includes(folder)){for(const theme of ['light','dark']){await setTheme(ev,theme);fs.writeFileSync(path.join(shotDir,`inbox-server-filter-${folder}-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
    await ev(`(()=>{const s=${select};s.value='box-2';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await waitFor(`${cells}.length>0&&${cells}.every(e=>${is('Remote box')})`,'Server filter narrows '+folder);
    // Clear the choice before testing mode changes or the next folder.
    await ev(`(()=>{const s=${select};s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    if(artifacts){
     // #8892: selecting one team removes its redundant Team column; Server and
     // its sort return. Clearing the team restores the cross-team layout (#8839).
     const team=`document.querySelector('#group-table-view #ia-team')`;
     await waitFor(`!!(${team})&&[...(${team}).options].some(o=>o.value==='same-team')`,'Artifacts Team filter choice');
     await ev(`(()=>{const s=${team};s.value='same-team';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
     await waitFor(`!!document.querySelector('#group-table-view th[data-key="server"]')&&!document.querySelector('#group-table-view th[data-key="team"]')`,'selected team shows Server instead of Team');
     const servers=`[...document.querySelectorAll('#group-table-view td[data-key="server"]')]`;
     await waitFor(`${servers}.length===1&&${servers}.every(e=>e.textContent==='This computer'&&e.getClientRects().length>0)`,'selected local team has its visible Server cell');
     // Use the phone's visible Sort by select, or the desktop's header button.
     assert.ok(await ev(`(()=>{const s=document.querySelector('#group-table-view .dt-sortbar select');if(s&&s.getClientRects().length){if(![...s.options].some(o=>o.value==='server'))return false;s.value='server';s.dispatchEvent(new Event('change',{bubbles:true}));return true;}const b=document.querySelector('#group-table-view th[data-key="server"] button.dt-sort');if(!b||!b.getClientRects().length)return false;b.click();return true;})()`),'selected team exposes a visible Server sort control');
     await waitFor(`document.querySelector('#group-table-view th[data-key="server"]')?.getAttribute('aria-sort')==='ascending'`,'selected team Server ascending sort');
     await ev(`(()=>{const s=document.querySelector('#group-table-view .dt-sortbar select');if(s&&s.getClientRects().length)document.querySelector('#group-table-view .dt-sortbar-dir').click();else document.querySelector('#group-table-view th[data-key="server"] button.dt-sort').click();return true;})()`);
     await waitFor(`document.querySelector('#group-table-view th[data-key="server"]')?.getAttribute('aria-sort')==='descending'`,'selected team Server descending sort');
     await ev(`(()=>{const s=${team};s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
     await waitFor(`!!document.querySelector('#group-table-view th[data-key="team"]')&&!!document.querySelector('#group-table-view th[data-key="server"]')`,'clearing team restores Team and its Computer column (#9408)');
     await waitFor(`${cells}.length===2&&${cells}.some(e=>e.textContent.includes('This computer'))&&${cells}.some(e=>e.textContent.includes('Remote box'))`,'clearing team restores both sources');
     assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .dt-sortbar select option')].some(o=>o.value==='server')`),false,'clearing team also removes Server from Sort by');
     console.log('PASS Artifacts team/Server column and sort round trip '+width);
    }
    console.log('PASS server '+folder+' '+width);
   }catch(e){failures.push(folder+' '+width+': '+e.message);console.error(failures.at(-1));}}
   // Same id on two sources: a remote Inbox preview must not capture a local URL.
   await open('chats');
   await waitFor(`!![...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.querySelector('td[data-key="server"]')?.textContent==='Remote box')`,'remote chat row');
   await ev(`window.__serverReads=[];[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.querySelector('td[data-key="server"]')?.textContent==='Remote box').querySelector('.dt-primary').click();true`);
   await waitFor(`window.__serverReads.includes('/api/remote/box-2/api/sessions/history/same-chat')&&window.__serverState.currentSession?.server==='box-2'`,'remote preview reads its server');
   await ev(`window.__serverReads=[];history.pushState({},'', '/chats/same-chat');window.dispatchEvent(new PopStateEvent('popstate'));true`);
   await waitFor(`window.__serverReads.includes('/api/sessions/history/same-chat')&&window.__serverState.currentSession?.server==='local'`,'local URL resets remote preview source');
   assert.ok(!(await ev(`window.__serverReads`)).includes('/api/remote/box-2/api/sessions/history/same-chat'),'local URL does not read the remote message page');
   for(const mode of ['standalone','only-local']){
    await ev(`window.__serverState.hub=${mode==='only-local'};window.__serverState.servers=[{id:'local',status:'online'}];true`);
    for(const folder of folders){await open(folder);assert.equal(await ev(`!!document.querySelector('#group-table-view th[data-key="server"]')`),false,mode+' hides Server in '+folder);}
   }
  }
  assert.equal(failures.length,0,failures.join('\n'));
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
