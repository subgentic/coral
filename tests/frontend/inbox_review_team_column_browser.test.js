// #14142: files for review share the question row's Team sort, including remote series. #16752: on a computer a file names its team on its meta line (no Team cell for it); a phone's card keeps the cell.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Page.addScriptToEvaluateOnNewDocument({source:"localStorage.setItem('coral-inbox-group-review-goal','false');"});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','liveList','liveListLoaded','settings');
   await ev(`(async()=>{const {state}=await import((window.__coralStatic||'/static/')+'state.js');state.hub=true;state.servers=[{id:'local',label:'This computer',status:'online'},{id:'box-2',label:'Laptop',status:'online',owner_stamp:true}];state.liveSessions=[];
    const old=window.fetch,json=b=>Promise.resolve(Response.json(b)),hex='2'.repeat(64);
    window.fetch=(u,o={})=>{const url=new URL(String(u),location.href),remote=url.pathname.startsWith('/api/remote/box-2/'),path=url.pathname.replace('/api/remote/box-2','');
     if(path==='/api/team-artifacts')return json(window.__reviewFixturePage(url,location.href,{alpha:{team:'Zulu reviews',artifacts:[{id:hex,name:remote?'remote-series.md':'local-series.md',series_id:'series',version:2,produced_by:'Writer',available:true,tags:['for review'],created_at:'2026-11-06T10:00:00Z'}]}}));
     if(path==='/api/operator-asks')return json(remote?[]:[{kind:'ask',board:'zulu',board_label:'Alpha questions',id:17,asker:'Orchestrator',text:'Question',at:'2026-11-06T10:00:00Z'}]);
     if(path==='/api/board/projects')return json([{project:'alpha',label:'Zulu reviews'},{project:'zulu',label:'Alpha questions'}]);
     return old(u,o);};return true;})()`);
   await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
   const row=name=>`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].find(r=>r.textContent.includes('${name}'))`;
   await waitFor(`!!(${row('local-series.md')})&&!!(${row('remote-series.md')})&&!!(${row('Question')})`,'local/remote series and question');
   for(const name of ['local-series.md','remote-series.md']){
    const team=await ev(width===1280?`(${row(name)}).querySelector('.inbox-meta .inbox-team').textContent.trim()`:`(${row(name)}).querySelector('[data-key="team"]').textContent.trim()`);
    assert.match(team,/Zulu reviews/,width+': '+name+' has a team');
    if(name==='remote-series.md')assert.match(team,/Laptop/,width+': remote team keeps its computer');
   }
   if(width===1280){
    await ev(`document.querySelector('#group-table-view th[data-key="team"] .dt-sort').click();true`);
    await waitFor(`document.querySelector('#group-table-view th[data-key="team"]')?.getAttribute('aria-sort')==='ascending'`,'Team column really sorted ascending');
    const order=await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r=>(r.querySelector('[data-key="team"]')?.textContent.trim()||r.querySelector('.inbox-meta .inbox-team')?.textContent.trim())).filter(Boolean)`);
    assert.equal(order.length,3);assert.match(order[0],/^Alpha questions/,'question team sorts before review teams; treating reviews as empty would reverse this');assert.deepEqual(order,[...order].sort((a,b)=>a.localeCompare(b)),'Team sort includes review rows');
   }
   assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`),true,'no horizontal overflow');
  }
  console.log('PASS review Team cell and sort for local/remote series at desktop and phone');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
