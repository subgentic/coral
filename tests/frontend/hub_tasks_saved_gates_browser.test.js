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
 }finally{await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
