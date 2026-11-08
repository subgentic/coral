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
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{const real=window.fetch;window.fetch=(u,o)=>new URL(String(u),location.href).pathname==='/api/account'?Promise.resolve(Response.json({tasks_native:true,saved_native:true,inbox_reply:true,saved_expand:true})):real(u,o)})()`});
  for(const width of [1280,390,320]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width!==1280});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','settings');
   await ev(`window.switchNavTab('hub-inbox');true`);
   await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{
    state.servers=[{id:'m1',label:'Owner one',owner:true,status:'online',coral_version:'2.0.62',effective_mode:'view'},{id:'m2',label:'Owner two',owner:true,status:'online',coral_version:'2.0.62',effective_mode:'interact'},{id:'m3',label:'Granted',owner:false,status:'online',effective_mode:'launch'},{id:'m4',label:'Offline',owner:true,status:'offline'},{id:'m5',label:'Unknown',status:'online',effective_mode:'launch'}];
    const real=window.fetch;window.__personalCalls=[];
    window.fetch=(u,o={})=>{const url=new URL(String(u),location.href),m=url.pathname.match(/^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/);if(!m)return real(u,o);const [,server,path]=m;
     if(path==='/api/board/tasks'){window.__personalCalls.push({server,path,query:url.search,method:o.method||'GET'});return Promise.resolve(Response.json({tasks:[{id:1,board_id:'alpha',title:'Operator '+server,status:'pending',assigned_to:'Operator'},{id:2,board_id:'alpha',title:'Review '+server,status:'review_pending',assigned_to:'Agent'},{id:3,board_id:'alpha',title:'Parked '+server,status:'draft',assigned_to:'Operator',parked_reason:'waiting'},{id:4,board_id:'alpha',title:'Other agent',status:'pending',assigned_to:'Agent'},{id:'../escape',board_id:'alpha',title:'Bad id',assigned_to:'Operator'},{id:5,board_id:'../escape',title:'Bad team',assigned_to:'Operator'}]}));}
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
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('saved'))`);
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
  }
 }finally{await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
