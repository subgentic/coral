// #17251: Usage Goal grouping and every task page, at tablet and desktop widths.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const shot=require('./helpers/scene_shots')(Page);
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:1024,height:768,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE});await Page.loadEventFired();await install();await require('./helpers/wait').coralReady(ev);
  await ev(`(()=>{const real=window.fetch.bind(window),json=d=>Promise.resolve(new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json'}}));const today=new Date().toISOString().slice(0,10);window.__pages=[];window.fetch=(u,o)=>{const url=new URL(String(u),location.href);if(url.pathname==='/api/board/tasks'){window.__pages.push(url.search);const start=url.searchParams.has('cursor')?100:0;return json({tasks:Array.from({length:start?1:100},(_,i)=>({id:start+i+1,board_id:'team',title:'Task '+(start+i+1),status:'completed',assigned_to:'Dev',priority:'medium',claimed_at:today+'T01:00:00Z',completed_at:today+'T02:00:00Z',cost_usd:start?0:1,input_tokens:50,output_tokens:20,cache_read_tokens:10,cache_write_tokens:5,goal_id:1,goal_title:'Goal A'})),...(start?{}:{next_cursor:'next-page'})});}if(url.pathname==='/api/token-usage/summary')return json({totals:{cost_usd:105,num_requests:10},by_model:[],by_agent_type:[],by_thinking:[],by_agent:[]});if(url.pathname==='/api/token-usage/timeseries'){const series=[{key:'a',label:'Goal A',cost_usd:60,num_requests:6,task_ids:[1,2]},{key:'b',label:'Goal B',cost_usd:40,num_requests:3,task_ids:[3]},{key:'untasked',label:'Not on a task',cost_usd:5,num_requests:1}];return json({buckets:[{bucket:today+'T00:00:00Z',cost_usd:105,num_requests:10,series}]});}return real(u,o);};return true;})()`);
  await ev(`window.switchNavTab('tokens');true`);
  const open=key=>ev(`import((window.__coralStatic||'/static/')+'analytics_views.js').then(m=>m.selectView('${key}')).then(()=>true)`);
  await open('task');
  await waitFor(`document.querySelectorAll('#cost-by-task tbody tr[data-key]').length===102`,'101 tasks plus unassigned spend',15000);
  assert.ok(await ev(`window.__pages.some(p=>p.includes('cursor=next-page'))`));
  assert.ok(await ev(`[...document.querySelectorAll('#cost-by-task tbody tr')].some(r=>r.textContent.includes('Task 101'))`),'zero-cost task on second page is present');
  for(const width of [1024,1440]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:false});
   await waitFor(`(()=>{const c=document.querySelector('#cost-by-task th[data-key="cost_usd"]');return c&&c.getBoundingClientRect().width>0&&getComputedStyle(c).display!=='none'})()`,'Cost visible at '+width,8000);
   const hidden=await ev(`!!document.querySelector('#cost-by-task .cols-hidden-btn:not([hidden])')`);
   if(hidden){
    await ev(`document.querySelector('#cost-by-task .cols-hidden-btn').click();true`);
    await waitFor(`document.querySelector('#cost-by-task .cols-hidden-btn').getAttribute('aria-expanded')==='true'`,'hidden columns menu opens',8000);
    assert.ok(await ev(`(()=>{const m=document.querySelector('#cost-by-task .cols-hidden-menu');const r=m.getBoundingClientRect();return !m.hidden&&r.width>0&&r.left>=0&&r.right<=innerWidth})()`));
    await shot('analytics-task-hidden-'+width);
    await ev(`document.querySelector('#cost-by-task .cols-hidden-menu [role="menuitem"]').click();true`);
    await waitFor(`document.querySelector('#cost-by-task .cols-hidden-btn').getAttribute('aria-expanded')==='false'`,'menu choice closes',5000);
   }
   await shot('analytics-tasks-'+width);
  }
  await open('usage');
  await waitFor(`!![...document.querySelectorAll('.atab-filters select')].find(e=>[...e.options].some(o=>o.value==='goal'))`,'Usage offers Goal',15000);
  await ev(`(()=>{const e=[...document.querySelectorAll('.atab-filters select')].find(e=>[...e.options].some(o=>o.value==='goal'));e.value='goal';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await waitFor(`!!document.querySelector('table[aria-label="Usage by goal"]')`,'goal breakdown table',15000);
  const cells=await ev(`[...document.querySelectorAll('table[aria-label="Usage by goal"] tbody tr')].map(r=>[...r.cells].map(c=>c.textContent))`);
  assert.deepEqual(cells.map(r=>r[0]),['Goal A','Goal B','Not on a task']);
  assert.equal(cells.reduce((n,r)=>n+Number(r[1].replace(/[^\d.]/g,'')),0),105);
  assert.equal(cells.reduce((n,r)=>n+Number(r[2]),0),10);
  assert.equal(cells[0][3],'2');
  for(const width of [1024,1440]){await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:false});await shot('analytics-goals-'+width);}
  console.log('PASS goal usage totals, all task pages and hidden columns at 1024/1440');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
