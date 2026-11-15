// #14690: Tasks and Saved opt into native tables independently; old accounts retain their frames.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {setupHubWorld,BASE}=require('./helpers/hub_world');
const {coralReady}=require('./helpers/wait');
(async()=>{
 const {client,Page,Emulation,ev,waitFor}=await connect();
 try{
  await setupHubWorld({client,Page,Emulation,width:1280,height:900,mobile:false,inbox:'native',needs:true,hubPages:true});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   for(const account of [{},{tasks_native:true},{saved_native:true},{tasks_native:true,saved_native:true},{tasks_native:false,saved_native:false},{tasks_native:'true',saved_native:1},'offline']){
    const {identifier}=await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{const real=window.fetch;window.__nativeAccountReads=0;window.fetch=(u,o)=>{if(new URL(String(u),location.href).pathname==='/api/account'){window.__nativeAccountReads++;return ${account==='offline'?"Promise.reject(Error('offline'))":'Promise.resolve(Response.json('+JSON.stringify(account)+'))'};}return real(u,o)};})()`});
    await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','settings');
    const flags=await ev(`import((window.__coralStatic||'/static/')+'server_base.js').then(m=>({tasks:m.nativeTasks?.(),saved:m.nativeSaved?.()}))`);
    assert.deepEqual(flags,{tasks:account.tasks_native===true,saved:account.saved_native===true},width+' strict independent account gates '+JSON.stringify(account));
    if(account.tasks_native===true&&account.saved_native===true){
     const reply=await ev(`import((window.__coralStatic||'/static/')+'inbox_coral.js').then(m=>m.coralInboxAdapter.canReply({project:'@m2/alpha',status:'pending'}))`);
     assert.equal(reply.ok,false,width+' owned Interact still refuses reply when inbox_reply is absent');
    }
    await ev(`window.switchNavTab('hub-inbox');true`);
    for(const [folder,enabled]of [['tasks',account.tasks_native===true],['saved',account.saved_native===true]]){
     await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('${folder}'))`);
     await waitFor(`document.querySelector('#group-table-view')?.getClientRects().length>0`,'folder mounted');
     assert.equal(await ev(`!!document.querySelector('#group-table-view iframe')`),!enabled,width+' '+folder+' frame fallback matches its gate');
    }
    assert.equal(await ev(`window.__nativeAccountReads`),1,'shared account reader is not duplicated per folder');
    await Page.removeScriptToEvaluateOnNewDocument({identifier});
   }
  }
  // Native data paths use explicit inventory ownership, browser filtering and source identities.
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{localStorage.setItem('coral-saved-filters',JSON.stringify({team:'@previous/board',kind:'board',sort:'oldest'}));localStorage.removeItem('coral.inbox.tab');const real=window.fetch;window.fetch=(u,o)=>new URL(String(u),location.href).pathname==='/api/account'?Promise.resolve(Response.json({tasks_native:true,saved_native:true,inbox_reply:true,saved_expand:true})):real(u,o)})()`});
  for(const width of [1280,390,320]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width!==1280});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','settings');
   await ev(`window.switchNavTab('hub-inbox');true`);
   await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{
    state.servers=[{id:'m1',label:'Owner one',owner:true,status:'online',coral_version:'2.0.62',effective_mode:'view'},{id:'m2',label:'Owner two',owner:true,status:'online',coral_version:'2.0.62',effective_mode:'interact'},{id:'m3',label:'Granted',owner:false,status:'online',effective_mode:'launch'},{id:'m4',label:'Offline',owner:true,status:'offline'},{id:'m5',label:'Unknown',status:'online',effective_mode:'launch'}];
    const real=window.fetch;window.__personalCalls=[];
    window.fetch=(u,o={})=>{const url=new URL(String(u),location.href),m=url.pathname.match(/^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/);if(!m)return real(u,o);const [,server,path]=m;
     if(path==='/api/board/tasks'){window.__personalCalls.push({server,path,query:url.search,method:o.method||'GET'});return Promise.resolve(Response.json({tasks:[{id:1,board_id:'alpha',title:'Operator '+server,status:'pending',assigned_to:'Operator'},{id:2,board_id:'alpha',title:'Review '+server,status:'review_pending',assigned_to:'Agent'},{id:3,board_id:'alpha',title:'Parked '+server,status:'draft',assigned_to:'Operator',parked_reason:'waiting'},{id:4,board_id:'alpha',title:'Other agent',status:'pending',assigned_to:'Agent'},{id:'../escape',board_id:'alpha',title:'Bad id',assigned_to:'Operator'},{id:5,board_id:'../escape',title:'Bad team',assigned_to:'Operator'}]}));}
     if(path==='/api/board/alpha/tasks/1'){window.__personalCalls.push({server,path,query:url.search,method:o.method||'GET'});return Promise.resolve(Response.json({id:1,title:'Detail '+server,body:'Task body '+server,status:'pending',assigned_to:'Operator',created_by:'Agent',goal_id:7,goal_title:'Source goal'}));}
     if(path==='/api/board/alpha/messages/all'){window.__personalCalls.push({server,path,query:url.search,method:o.method||'GET'});return Promise.resolve(Response.json([]));}
     if(path==='/api/board/alpha/tasks/1/reply'){window.__personalCalls.push({server,path,query:url.search,method:o.method||'GET'});return Promise.resolve(Response.json({error:'Reply refused'},{status:403}));}
     if(path==='/api/saved'){window.__personalCalls.push({server,path,query:url.search,method:o.method||'GET'});return Promise.resolve(Response.json({items:[{id:1,kind:'board',key:'7',ref:'alpha',team:'alpha',title:'Saved '+server,snippet:'private snippet '+server,saved_at:'2026-11-08T10:00:00Z',server:'m3'}],open:1,done:0,has_more:true}));}
     if(path==='/api/saved/1/message'){window.__personalCalls.push({server,path,query:url.search,method:o.method||'GET'});return Promise.resolve(Response.json({text:'Stored source '+server,partial:true,reason:'too_long'}));}
     return real(u,o);
    };return true;
   })`);
   assert.equal(await ev('window.__personalCalls.length'),0,'personal folders are cold before opening');
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('tasks'))`);
   await waitFor(`document.querySelector('#group-table-view').textContent.includes('Operator m1')`,'owned native tasks paint');
   const taskCheck=await ev(`import((window.__coralStatic||'/static/')+'inbox_coral.js').then(async m=>{const rows=await m.coralInboxAdapter.listTasks();return {keys:rows.map(t=>t.project+'#'+t.id).sort(),view:m.coralInboxAdapter.canReply({project:'@m1/alpha',status:'pending'}),interact:m.coralInboxAdapter.canReply({project:'@m2/alpha',status:'pending'}),review:m.coralInboxAdapter.canReply({project:'@m2/alpha',status:'review_pending'}),parked:m.coralInboxAdapter.canReply({project:'@m2/alpha',status:'draft',parked_reason:'wait'}),grantee:m.coralInboxAdapter.canReply({project:'@m3/alpha',status:'pending'})}})`);
   assert.deepEqual(taskCheck.keys,['@m1/alpha#1','@m1/alpha#2','@m1/alpha#3','@m2/alpha#1','@m2/alpha#2','@m2/alpha#3']);
   assert.equal(taskCheck.view.ok,false);assert.equal(taskCheck.interact.ok,true);assert.equal(taskCheck.review.ok,false);assert.equal(taskCheck.parked.ok,false);assert.equal(taskCheck.grantee.ok,false);
   await ev(`[...document.querySelectorAll('#group-table-view button[data-task-id="1"]')].find(b=>b.textContent.includes('Operator m2')).click();true`);
   await waitFor(`!!document.querySelector('.ibx-reply-input')&&document.querySelector('.ibx-reply-input').getClientRects().length>0`,'owner Interact task reply is offered');
   assert.equal(await ev(`document.querySelector('.ibx-task-title').textContent`),'Detail m2');
   assert.equal(await ev(`!![...document.querySelectorAll('.ibx-goal')].find(b=>b.textContent==='Goal: Source goal')`),true,'source-qualified goal is retained');
   await ev(`(()=>{const t=document.querySelector('.ibx-reply-input');t.value='One attempted reply';t.dispatchEvent(new Event('input',{bubbles:true}));t.form.requestSubmit();return true})()`);
   await waitFor(`document.querySelector('.ibx-reply-status')?.textContent==='Reply refused'`,'authoritative reply refusal is shown');
   assert.equal(await ev(`window.__personalCalls.filter(c=>c.path.endsWith('/reply')).length`),1,'a refused reply is never automatically resent');
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('saved'))`);
   const initialSavedFilters=await ev(`import((window.__coralStatic||'/static/')+'saved.js').then(m=>m.savedFiltersNow())`);
   assert.equal(initialSavedFilters.team,'',width+' Hub Saved ignores the unscoped previous-account Team filter');
   assert.equal(initialSavedFilters.sort,'newest',width+' Hub Saved ignores the unscoped previous-account sort');
   await waitFor(`import((window.__coralStatic||'/static/')+'saved.js').then(m=>m.savedView().shown.length===2)`,'owned saved sources loaded');
   const before=await ev('window.__personalCalls.length');
   const savedCheck=await ev(`import((window.__coralStatic||'/static/')+'saved.js').then(async m=>{await m.setSavedQuery('private snippet m1');const view=m.savedView(),it=view.shown[0];return {sources:view.shown.map(i=>i.server),capped:view.capped,notice:view.notice,done:await m.savedSetDone(it,true),remove:await m.savedRemove(it)}})`);
   assert.deepEqual(savedCheck.sources,['m1'],'colliding bookmark ids remain source-qualified and filters stay in memory');assert.equal(savedCheck.capped,true);assert.match(savedCheck.notice,/owner sees/);assert.equal(savedCheck.done,false);assert.equal(savedCheck.remove,false);
   assert.equal(await ev('window.__personalCalls.length'),before,'search and read-only actions issue no request');
   assert.equal(await ev(`!![...document.querySelectorAll('#group-table-view button')].find(b=>/^(Mark done|Reopen, move|Remove from saved)/.test(b.getAttribute('aria-label')||''))`),false,'read-only native Saved has no mutation buttons');
   const expanded=await ev(`import((window.__coralStatic||'/static/')+'inbox_coral.js').then(async m=>{const result=await m.coralInboxAdapter.readSavedMessage({server:'m1',id:1});let refused=false;try{await m.coralInboxAdapter.readSavedMessage({server:'m3',id:1})}catch{refused=true}return {result,refused}})`);
   assert.deepEqual(expanded,{result:{text:'Stored source m1',partial:true,reason:'too_long'},refused:true});
   const versionBefore=await ev('window.__personalCalls.length');
   const oldVersion=await ev(`Promise.all([import((window.__coralStatic||'/static/')+'state.js'),import((window.__coralStatic||'/static/')+'saved.js'),import((window.__coralStatic||'/static/')+'inbox_coral.js')]).then(async ([{state},S,C])=>{state.servers.find(s=>s.id==='m1').coral_version='2.0.61';S.savedInventoryChanged();let refused=false;try{await C.coralInboxAdapter.readSavedMessage({server:'m1',id:1})}catch{refused=true}return {refused,notice:S.savedView().notice,sources:S.savedView().shown.map(i=>i.server)}})`);
   assert.equal(oldVersion.refused,true);assert.match(oldVersion.notice,/requires Coral 2.0.62/);assert.ok(!oldVersion.sources.includes('m1'));assert.equal(await ev('window.__personalCalls.length'),versionBefore,'older computer expansion is withheld without a request');
   const calls=await ev('window.__personalCalls');
   assert.ok(calls.every(c=>['m1','m2'].includes(c.server)),'no grantee, unknown or offline personal reads');
   assert.ok(calls.filter(c=>c.path==='/api/saved').every(c=>c.query==='?limit=200'),'only the fixed bounded Saved query is sent');
   assert.ok(calls.every(c=>!c.query.includes('private')&&!c.query.includes('snippet')),'filter canaries never enter GET queries');
   await ev(`import((window.__coralStatic||'/static/')+'saved.js').then(async m=>{await m.setSavedFilters({});await m.setSavedQuery('')})`);
   await ev(`window.toggleAgenticPanel?.(true);window.switchAgenticTab?.('saved','top');true`);
   await waitFor(`document.querySelector('#saved-table')?.textContent.includes('Saved m2')`,'native Saved is available in the shared dock');
   assert.equal(await ev(`document.body.classList.contains('cloud-native-saved')&&!!document.querySelector('#agentic-tab-saved')?.getClientRects().length`),true,width+' strict Saved gate reveals the shared read-only dock tab');
   for(const folder of ['needs','tasks','goals','chats']){
    await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('${folder}'))`);
    assert.equal(await ev(`!!document.querySelector('#agentic-tab-saved')?.getClientRects().length`),true,width+' Saved dock stays available under '+folder);
    assert.equal(await ev(`document.querySelector('#saved-table')?.textContent.includes('Saved m2')`),true,width+' shared Saved rows remain mounted under '+folder);
   }
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('tasks'))`);
   await waitFor(`document.querySelector('#group-table-view').textContent.includes('Operator m1')`,'owned tasks return for account-change check');
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.setInboxSearch('private task search'))`);
   await ev(`import((window.__coralStatic||'/static/')+'saved.js').then(async m=>{await m.setSavedFilters({team:'@m1/alpha',kind:'board',sort:'oldest'});await m.setSavedQuery('private saved search')})`);
   assert.equal(await ev(`localStorage.getItem('coral-saved-filters')`),JSON.stringify({team:'@previous/board',kind:'board',sort:'oldest'}),width+' Hub Saved never reads or writes the shared local filter key');
   await ev(`import((window.__coralStatic||'/static/')+'local_store.js').then(m=>m.forgetAccountMemory())`);
   await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{state.servers=[];return true})`);
   const forgotten=await ev(`Promise.all([import((window.__coralStatic||'/static/')+'saved.js'),import((window.__coralStatic||'/static/')+'inbox_sidebar.js')]).then(([s,i])=>({saved:s.savedView(),filters:s.savedFiltersNow(),counts:i.folderSections?.(),search:document.querySelector('#inbox-search')?.value,shared:localStorage.getItem('coral-saved-filters')}))`);
   assert.equal(forgotten.saved.query,'',width+' account change clears Saved query');
   assert.equal(forgotten.filters.team,'',width+' account change clears Saved Team filter');
   assert.equal(forgotten.filters.kind,'',width+' account change clears Saved kind filter');
   assert.equal(forgotten.filters.sort,'newest',width+' account change restores Saved default sort');
   assert.deepEqual(forgotten.saved.shown,[],width+' account change clears Saved rows');
   assert.equal(forgotten.search,'',width+' account change clears the visible Saved search');
   assert.equal(forgotten.shared,JSON.stringify({team:'@previous/board',kind:'board',sort:'oldest'}),width+' Hub filters do not change shared local storage');
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('tasks'))`);
   assert.equal(await ev(`document.querySelector('#inbox-search')?.value`),'',width+' reopening Tasks uses an empty search after account change');
   assert.equal(await ev(`document.querySelector('#group-table-view').textContent.includes('Operator m1')`),false,width+' reopened Tasks contain no previous-account rows');
  }
 }finally{await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
