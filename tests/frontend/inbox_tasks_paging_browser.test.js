// #17325: older Operator tasks remain reachable; state/search query the source, not its loaded window.
const assert = require('node:assert/strict');
const { showTasksTab } = require('./helpers/tasks_tab.js');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try {
  await Page.enable(); await showTasksTab(Page); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{const R=window.fetch; window.__taskQueries=[];
   const all=Array.from({length:130},(_,i)=>({id:i+1,board_id:'tasks-team',title:'Done '+i,status:'completed',assigned_to:'Operator',updated_at:'2026-11-16T12:00:00Z'})).concat(
    Array.from({length:110},(_,i)=>({id:i+200,board_id:'tasks-team',title:'Open '+i,status:'pending',priority:'medium',assigned_to:'Operator',updated_at:'2026-11-15T12:00:00Z'})),
    [{id:999,board_id:'tasks-team',title:'Old blocked task',body:'hidden needle',status:'blocked',priority:'high',assigned_to:'Operator',updated_at:'2026-01-01T00:00:00Z'}],
    [{id:1000,board_id:'tasks-team',title:'Another person',status:'blocked',assigned_to:'Developer',updated_at:'2026-01-01T00:00:00Z'}]);
   window.fetch=(u,o={})=>{const url=new URL(String(u),location.href); if(url.pathname!=='/api/board/tasks')return R(u,o);
    window.__taskQueries.push(url.search); const p=url.searchParams, states=p.getAll('status');
    let rows=all.filter(t=>(!p.has('assigned_to')||t.assigned_to===p.get('assigned_to'))&&(!states.length||states.includes(t.status))&&(!p.get('q')||(t.title+' '+(t.body||'')).toLowerCase().includes(p.get('q').toLowerCase())));
    const at=Number(p.get('cursor')||0), limit=Number(p.get('limit')||100), page=rows.slice(at,at+limit);
    return Promise.resolve(new Response(JSON.stringify({tasks:page,total:rows.length,...(at+limit<rows.length?{next_cursor:String(at+limit)}:{})}),{headers:{'Content-Type':'application/json'}}));};})();`});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
   await ev(`window.switchNavTab('hub-inbox'); true`);
   await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('tasks'))`);
   await waitFor(`!!document.querySelector('[data-task-more="local"]')`,'older tasks have Load more',6000);
   const rows=()=>ev(`document.querySelectorAll('#group-table-view tbody .dt-primary').length`);
   assert.equal(await rows(),50,'bounded first page');
   for(const count of [100,111]){
    await ev(`document.querySelector('[data-task-more="local"]').click();true`);
    await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length===${count}`,'load next page '+count,5000);
   }
   assert.equal(await ev(`!!document.querySelector('[data-task-more]')`),false,'last page has no Load more');
   assert.ok(await ev(`document.querySelector('#group-table-view').textContent.includes('Old blocked task')`),'old task after 110 open rows appears');
   assert.equal(await ev(`document.querySelector('#group-table-view').textContent.includes('Another person')`),false,'assignee is filtered on source');
   await ev(`(()=>{const h=document.querySelector('#group-table-view'); const b=[...h.querySelectorAll('.team-tb-pills button')].find(b=>b.textContent.startsWith('Blocked'));if(b)b.click();else{const s=h.querySelector('.inbox-pill-field select');s.value='Blocked';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
   await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length===1 && window.__taskQueries.some(q=>new URLSearchParams(q).getAll('status').join(',')==='blocked')`,'Blocked uses server status filter',5000);
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.filterInbox('hidden needle'))`);
   await waitFor(`window.__taskQueries.some(q=>new URLSearchParams(q).get('q')==='hidden needle') && document.querySelectorAll('#group-table-view tbody .dt-primary').length===1`,'body search reaches source',5000);
   assert.ok(await ev(`document.querySelector('#group-table-view').textContent.includes('Old blocked task')`),'body match survives client display');
   assert.ok(await ev(`window.__taskQueries.every(q=>{const p=new URLSearchParams(q);return p.get('assigned_to')==='Operator'&&!p.getAll('status').includes('completed');})`),'completed tasks never crowd out Operator open tasks');
   console.log('PASS '+width+'px: 111 open tasks paged, old blocked task found, body search and assignee/status query');
  }
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
