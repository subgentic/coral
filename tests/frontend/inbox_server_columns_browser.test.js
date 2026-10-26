// #8708: every Inbox folder carries origin, sorting and a Server filter in hub mode.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const BASE=require('./test_base').BASE;
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
     if(p==='/api/team-artifacts'){
      const id=(remote?'b':'a').repeat(64);return json({artifacts:[{id,name:label+' report.txt',media_type:'text/plain',size:25,created_at:now,board_id:'same-team',team:label+' team',task_id:0,source:'upload',available:true,uri:'coral://artifacts/'+id,produced_by:label+' agent'}],all:1,total:1,has_more:false,teams:[{board_id:'same-team',team:label+' team',all:1}]});
     }
     if(remote)return json({});return real(url,opts);
    };(await import((window.__coralStatic||'/static/')+'inbox_tab.js')).updateInboxTab();return true;
   })()`);
   for(const folder of folders){try{
    await open(folder);
    await waitFor(`!!document.querySelector('#group-table-view th[data-key="server"]')`,'Server column in '+folder,5000);
    const cells=`[...document.querySelectorAll('#group-table-view td[data-key="server"]')]`;
    await waitFor(`${cells}.some(e=>e.textContent==='This computer')&&${cells}.some(e=>e.textContent==='Remote box')`,'both origins in '+folder,8000);
    if(width===390)assert.ok(await ev(`${cells}.every(e=>e.getClientRects().length>0)`),'Server visible on phone');
    assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow');
    const sortable=await ev(`(() => {const s=[...document.querySelectorAll('#group-table-view .dt-sortbar select')].find(s=>[...s.options].some(o=>o.value==='server'));if(s&&s.getClientRects().length){s.value='server';s.dispatchEvent(new Event('change',{bubbles:true}));return true;}const h=document.querySelector('#group-table-view th[data-key="server"]');const b=h?.querySelector('button');if(b){b.click();return true;}return false;})()`);
    assert.ok(sortable,'Server sort control in '+folder);
    await ev(`document.querySelector('#group-table-view .list-bar-toggle').click();true`);
    const select=`[...document.querySelectorAll('.list-bar-field')].find(e=>e.querySelector('.list-bar-field-label')?.textContent.trim()==='Server')?.querySelector('select')`;
    await waitFor(`!!(${select})&&(${select}).getClientRects().length>0`,'Server filter in '+folder);
    await ev(`(()=>{const s=${select};s.value='box-2';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await waitFor(`${cells}.length>0&&${cells}.every(e=>e.textContent==='Remote box')`,'Server filter narrows '+folder);
    // Clear the choice before testing mode changes or the next folder.
    await ev(`(()=>{const s=${select};s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    console.log('PASS server '+folder+' '+width);
   }catch(e){failures.push(folder+' '+width+': '+e.message);console.error(failures.at(-1));}}
   for(const mode of ['standalone','only-local']){
    await ev(`window.__serverState.hub=${mode==='only-local'};window.__serverState.servers=[{id:'local',status:'online'}];true`);
    for(const folder of folders){await open(folder);assert.equal(await ev(`!!document.querySelector('#group-table-view th[data-key="server"]')`),false,mode+' hides Server in '+folder);}
   }
  }
  assert.equal(failures.length,0,failures.join('\n'));
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
