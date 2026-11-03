// #12667: computer-owned resources on a remote team's page never read the Hub's data.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
(async () => {
 const {client,Page,Emulation,ev,waitFor}=await connect();
 const S="(window.__coralStatic||'/static/')";
 try {
  await setupHubWorld({client,Page,Emulation,width:1280,height:844,mobile:false,inbox:'native',hubPages:true});
  await Page.addScriptToEvaluateOnNewDocument({source:`(() => {
   window.__computers.forEach((c,i)=>c.id='srv'+(i+1));
   const original=window.fetch; window.__resourceCalls=[];
   window.fetch=(u,o={})=>{
    const p=new URL(String(u),location.href).pathname;
    const match=p.match(/^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/);
    const path=match?match[2]:p, server=match?match[1]:'HUB';
    const json=x=>Promise.resolve(new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}}));
    if (/^\\/api\\/(chief|views|folder-tags|tags|templates)(\\/|$)/.test(path)) {
     window.__resourceCalls.push({server,path,method:o.method||'GET',body:o.body});
     if(path==='/api/chief')return json({enabled:true,name:'Chief '+server});
     if(path==='/api/views'&&window.__holdViews===server)return new Promise(resolve=>{window.__releaseViews=()=>resolve(new Response(JSON.stringify([{id:7,name:'STALE view',html:'old'}])));});
     if(path==='/api/views')return json([{id:7,name:'View '+server,html:'<p>Text</p>'}]);
     if(path==='/api/folder-tags')return json({app:[{id:7,name:'Tag '+server,color:'#123456'}]});
     if(path==='/api/tags')return json([{id:7,name:'Tag '+server,color:'#123456'}]);
     if(path==='/api/templates/agents')return json([{name:'coding'}]);
     if(path==='/api/templates/agents/coding')return json([{name:'helper'}]);
     if(path==='/api/templates/agents/coding/helper')return json({name:'Helper '+server,body:'Template '+server});
     return json({});
    }
    return original(u,o);
   };
  })();`});
  await Page.navigate({url:BASE+'/team/@srv1/team'});await Page.loadEventFired();
  await coralReady(ev,'startup','liveList','settings');
  await waitFor(`document.getElementById('team-page-view').checkVisibility()`,'remote team');
  const failures=[];
  const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);}};
  await check('chief look per computer',async()=>{
   const names=await ev(`(async()=>{const {state}=await import(${S}+'state.js'),m=await import(${S}+'chief_look.js'); const names=[];for(const s of ['srv1','srv2','srv1']){state.selectedTeam='@'+s+'/team';names.push((await m.readChief())?.name);}return names;})()`);
   assert.deepEqual(names,['Chief srv1','Chief srv2','Chief srv1']);
  });
  await check('custom views per computer',async()=>{
   for(const server of ['srv1','srv2']){
    await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.selectedTeam='@${server}/team';await (await import(${S}+'custom_views.js')).loadCustomViews();return true;})()`);
    assert.ok(await ev(`document.getElementById('custom-view-tabs').textContent!==null && !!document.querySelector('#custom-view-tabs [title="View ${server}"]')`),'correct computer view');
   }
   await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.selectedTeam='@srv1/team';window.__holdViews='srv1';window.__heldViewRead=(await import(${S}+'custom_views.js')).loadCustomViews();return true;})()`);
   await waitFor(`typeof window.__releaseViews==='function'`,'held old computer views');
   await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.selectedTeam='@srv2/team';await (await import(${S}+'custom_views.js')).loadCustomViews();window.__releaseViews();await window.__heldViewRead;return true;})()`);
   assert.ok(await ev(`!!document.querySelector('#custom-view-tabs [title="View srv2"]') && !document.querySelector('#custom-view-tabs [title="STALE view"]')`),'late old-computer views do not replace the new computer');
  });
  await check('folder tags per computer and scoped writes',async()=>{
   const tags=await ev(`(async()=>{const m=await import(${S}+'folder_tags.js');await m.loadAllFolderTags();return [m.getFolderTags('@srv1/app')[0]?.name,m.getFolderTags('@srv2/app')[0]?.name];})()`);
   assert.deepEqual(tags,['Tag srv1','Tag srv2']);
   await ev(`(async()=>{const m=await import(${S}+'folder_tags.js');await window.addFolderTag('@srv1/app',7);await window.removeFolderTag('@srv2/app',7);return true;})()`);
   const writes=await ev(`window.__resourceCalls.filter(c=>c.path.includes('folder-tags')&&c.method!=='GET')`);
   assert.deepEqual(writes.map(c=>[c.server,c.path,c.method]),[['srv1','/api/folder-tags/app','POST'],['srv2','/api/folder-tags/app/7','DELETE']]);
  });
  const calls=await ev('window.__resourceCalls');
  assert.deepEqual(failures,[],'all remote resources are scoped');
  console.log('PASS remote @srv1/team resources and two-computer isolation');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
