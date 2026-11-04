// #13160: remote metadata must not rebuild the Inbox Artifacts page. Structural
// computer changes retain its node/pages/scroll; real prepend retains a row anchor.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const h=await connect();const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=h;
 const S=`(window.__coralStatic || '/static/')`;
 const ROWS='#group-table-view tbody tr';
 const setup=async(width,hub)=>{
  await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await ev(`(async()=>{
   localStorage.removeItem('coral-team-artifacts-filters:@inbox');localStorage.removeItem('coral.inbox.tab');
   window.__reads=0;window.__prepend=0;window.__held=[];window.__hold=false;
   const state=(await import(${S}+'state.js')).state;
   window.__servers=${hub?"[{id:'remote-a',label:'Remote A',status:'online',owner_stamp:true,last_seen:'2026-11-04T00:00:00Z',agents:1}]":"[]"};
   state.hub=${hub};state.servers=window.__servers;state.serversKnown=true;
   const real=window.fetch,json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
   const row=(i,fresh=false)=>({id:String(i+1).padStart(64,'0'),name:(fresh?'new-':'report-')+i+'.md',media_type:'text/markdown',size:100,created_at:new Date(Date.UTC(2026,10,4)+(fresh?i:-i)*60000).toISOString(),source:'upload',tags:[],available:true,board_id:'alpha',team:'alpha'});
   window.fetch=async(u,o={})=>{
    const url=new URL(String(u),location.origin),p=url.pathname;
    if(p.endsWith('/api/team-artifacts')){
     const remote=p.includes('/api/remote/'),limit=Number(url.searchParams.get('limit')||100),start=Number(url.searchParams.get('cursor')||url.searchParams.get('offset')||0);
     const all=remote?[]:[...Array.from({length:window.__prepend},(_,i)=>row(10000+i,true)).reverse(),...Array.from({length:700},(_,i)=>row(i))];
     const artifacts=all.slice(start,start+limit),more=start+artifacts.length<all.length;
     if(limit>1){window.__reads++;if(window.__hold)await new Promise(r=>window.__held.push(r));}
     return json({artifacts,limit,offset:start,has_more:more,next_cursor:more?String(start+artifacts.length):'',total:all.length,all:all.length,teams:[{board_id:'alpha',team:'alpha',all:all.length}]});
    }
    if(p==='/api/system/artifact-store/kept')return json({kept:[]});
    if(p==='/api/servers')return json(window.__servers);
    if(p==='/api/sessions/live'){const r=await real(u,o),d=await r.json();return json({sessions:Array.isArray(d)?d:d.sessions||[],servers:window.__servers});}
    return real(u,o);
   };
   window.switchNavTab('hub-inbox');await (await import(${S}+'inbox_sidebar.js')).openInboxGroup('artifacts');
  })()`);
  await waitFor(`document.querySelectorAll('${ROWS}').length>=100`,'initial artifact page');
  await ev(`window.__scroller=()=>{let e=document.querySelector('${ROWS}');while(e&&!(e.scrollHeight>e.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)))e=e.parentElement;return e||document.scrollingElement;};true`);
 };
 const position=()=>ev(`(()=>{const s=window.__scroller(),top=s===document.scrollingElement?0:s.getBoundingClientRect().top;const r=[...document.querySelectorAll('${ROWS}')].find(r=>r.getBoundingClientRect().top>=top+40);return{scroll:s.scrollTop,key:r?.dataset.key,y:r?.getBoundingClientRect().top,n:document.querySelectorAll('${ROWS}').length}})()`);
 const middle=async()=>{
  await ev(`(()=>{const s=window.__scroller(),rows=document.querySelectorAll('${ROWS}'),r=rows[Math.floor(rows.length/2)];s.scrollTop+=r.getBoundingClientRect().top-s.getBoundingClientRect().top;window.__list=document.querySelector('.team-artifacts-body');return true;})()`);
  const p=await position();await ev(`window.__anchorRow=[...document.querySelectorAll('${ROWS}')].find(r=>r.dataset.key===${JSON.stringify(p.key)});true`);assert.ok(p.scroll>300,'test has scrolled into the list');return p;
 };
 const anchor=async(before,label,pixels=true,sameRow=pixels)=>{
  const after=await ev(`(()=>{const r=[...document.querySelectorAll('${ROWS}')].find(r=>r.dataset.key===${JSON.stringify(before.key)});return{sameRow:r===window.__anchorRow,connected:window.__list.isConnected,same:document.querySelector('.team-artifacts-body')===window.__list,scroll:window.__scroller().scrollTop,y:r?.getBoundingClientRect().top,n:document.querySelectorAll('${ROWS}').length};})()`);
  assert.equal(after.connected,true,label+': old list stays connected');assert.equal(after.same,true,label+': list node survives');
  assert.equal(after.n,before.n,label+': loaded pages retained');
  if(sameRow)assert.equal(after.sameRow,true,label+': unchanged row node retained');
  if(pixels)assert.ok(Math.abs(after.scroll-before.scroll)<=3,label+': scrollTop '+before.scroll+' -> '+after.scroll);
  assert.ok(Math.abs(after.y-before.y)<=3,label+': row screen Y '+before.y+' -> '+after.y);
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await setup(width,true);
   for(let i=0;i<5;i++){
    const n=await ev(`document.querySelectorAll('${ROWS}').length`);if(n>=300)break;
    await ev(`window.__scroller().scrollTop=window.__scroller().scrollHeight`);
    await waitFor(`document.querySelectorAll('${ROWS}').length>${n}`,'additional page');
   }
   let before=await middle();assert.ok(before.n>=200,'multiple pages loaded');
   await ev(`(async()=>{window.__hold=true;const {state}=await import(${S}+'state.js');state.servers=window.__servers=state.servers.map(s=>({...s,last_seen:'2026-11-04T00:01:00Z',agents:2}));(await import(${S}+'sidebar_groups.js')).refreshGroupTable('hub-inbox');})()`);
   // A pending first-page response must not hide a transient Loading-height collapse.
   await anchor(before,width+' metadata while response held');
   await ev(`window.__hold=false;window.__held.splice(0).forEach(r=>r());true`);
   await anchor(before,width+' metadata after release');
   const reads=await ev(`window.__reads`);
   before=await middle();
   await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.servers=window.__servers=state.servers.map(s=>({...s,label:'Renamed remote'}));(await import(${S}+'sidebar_groups.js')).refreshGroupTable('hub-inbox');})()`);
   await anchor(before,width+' structural rename',true,false);
   assert.equal(await ev(`window.__reads`),reads,'renaming a computer does not throw away loaded artifact pages');
   console.log('[PASS] '+width+' metadata and rename');
   for(const hub of [false,true]){
    await setup(width,hub);before=await middle();
    const reads=await ev(`window.__reads`);
    await ev(`window.__prepend=3;window.dispatchEvent(new Event('focus'));true`);
    await waitFor(`window.__reads>${reads}`,'quiet read after actual prepend');
    await waitFor(`document.querySelector('${ROWS}')?.textContent.includes('new-')`,'new files really precede old rows');
    await anchor(before,width+' prepend hub='+hub,false);
    console.log('[PASS] '+width+' real prepend hub='+hub);
   }
  }
 }finally{await client.close();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
