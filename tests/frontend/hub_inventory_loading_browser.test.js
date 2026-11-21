// #20427: an unknown Hub inventory is loading, not an empty account. Hold the
// real startup inventory reads, then release them; no timing-based readiness.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {setupHubWorld,BASE}=require('./helpers/hub_world');
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD}=await connect();const failed=[];
 const shot=async name=>{const dir=process.env.CORAL_SCREENSHOT_DIR;if(!dir)return;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await setupHubWorld({client,Page,Emulation,width:1280,height:844,mobile:false,inbox:'native',needs:true});
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{
   class Quiet extends EventTarget{constructor(){super();this.readyState=0;}send(){}close(){this.readyState=3;}}Object.assign(Quiet,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});window.WebSocket=Quiet;
   window.__noComputers=new URLSearchParams(location.search).has('empty');const real=window.fetch;let release;const held=new Promise(r=>release=r);window.__pageReads=[];window.__releaseInventory=()=>{window.__inventoryReleased=true;release();};
   window.fetch=async(u,o)=>{const p=new URL(String(u),location.href).pathname;if(p==='/api/sessions/live'||p==='/api/servers'){window.__inventoryHeld=true;await held;}
    if(p.startsWith('/api/remote/')&&['/api/skills','/api/scheduled/jobs','/api/token-usage'].some(end=>p.endsWith(end))){window.__pageReads.push(p);if(p.endsWith('/skills'))return Response.json({skills:[{id:'deploy',name:'Deploy skill',version:1,status:'approved',description:'A linked skill'}]});if(p.endsWith('/scheduled/jobs'))return Response.json({jobs:[{id:1,name:'Nightly job',enabled:true,cron_expr:'0 1 * * *',timezone:'UTC'}]});}
    if(p.startsWith('/api/remote/')&&p.includes('/api/token-usage/')){window.__pageReads.push(p);if(p.endsWith('/summary'))return Response.json({totals:{cost_usd:7,num_requests:3,num_sessions:1,input_tokens:100,output_tokens:20,cache_read_tokens:0,cache_write_tokens:0}});if(p.endsWith('/timeseries'))return Response.json({buckets:[{bucket:new Date().toISOString(),cost_usd:7,cumulative_cost:7,input_tokens:100,output_tokens:20,cache_read_tokens:0,cache_write_tokens:0,num_requests:3}]});return Response.json({});}return real(u,o);};
  })()`});
  const pages=[['goals','/inbox/goals','#group-table-view','Goal from'],['analytics','/analytics','#cost-page',''],['skills','/skills','#skills-view','Deploy skill'],['automations','/automations/jobs','#scheduler-detail','Nightly job']];
  for(const [width,empty] of [[1280,false],[390,false],[390,true]])for(const [name,path,selector,done]of pages){
   await Emulation.setDeviceMetricsOverride({width,height:844,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+path+(empty?'?empty=1':'')});await Page.loadEventFired();
   await waitFor(`window.__inventoryHeld&&typeof window.switchNavTab==='function'`, 'navigation while inventory is held',15000);
   const tab={goals:'hub-inbox',analytics:'tokens',skills:'skills',automations:'automations'}[name];
   await ev(`window.switchNavTab(${JSON.stringify(tab)});true`);
   if(name==='goals')await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('goals')).then(()=>true)`);
   if(name==='automations')await ev(`import((window.__coralStatic||'/static/')+'automations_cloud.js').then(m=>m.openAutomationsRoute({folder:'jobs'}))`);
   await waitFor(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim().length>0`,name+' shell while inventory is held',15000);
   if(name==='goals') {
    // #20503: the folder's own empty state must win over ordinary empty/update text,
    // not merely a Loading computers message elsewhere in the surrounding shell.
    await waitFor(`document.querySelector('#group-table-view .empty-state-line')?.textContent==='Loading goals…'`, 'Goals empty state takes loading precedence while inventory is unknown');
   }
   if(name==='analytics')await ev(`import((window.__coralStatic||'/static/')+'analytics_views.js').then(m=>m.selectView('overview'))`);
   const text=await ev(`document.querySelector(${JSON.stringify(selector)}).textContent`);
   if(!empty)await shot(`${width}-${name}-held`);console.log(width+' '+name+' held: '+text.slice(0,140));
   if(name==='analytics'&&await ev(`document.querySelector('#cost-total-cost').textContent`)!=='—')failed.push(width+' pending usage looks like a measured zero');
   if(!/Loading (computers|goals|skills|automations|usage)/i.test(text)||/No open goals|Link a computer|No computer is linked|No skills yet/.test(text))failed.push(width+' '+name+' held: '+text.slice(0,350));
   await ev(`window.__releaseInventory();true`);
   await waitFor(`import((window.__coralStatic||'/static/')+'state.js').then(m=>m.state.serversKnown)`,name+' known inventory');
   const expected=empty?({goals:'No open goals',analytics:'Link a computer to see usage',skills:'No computer is linked',automations:'Link a computer to see automations'}[name]):done;
   try { await waitFor(name==='analytics'&&!empty?`document.querySelector('#cost-total-cost').textContent.includes('7.00')`:`document.querySelector(${JSON.stringify(selector)}).textContent.includes(${JSON.stringify(expected)})`,name+' content after inventory',15000); } catch(e) { failed.push(width+' '+name+': '+e.message); }
   if(!empty)await shot(`${width}-${name}-loaded`);
   assert.equal(await ev(`document.documentElement.scrollWidth>innerWidth+1`),false,width+' '+name+' page overflow');
  }
  assert.deepEqual(failed,[]);console.log('PASS Hub inventory loading: four pages at 1280/390 wait, then show linked content');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
