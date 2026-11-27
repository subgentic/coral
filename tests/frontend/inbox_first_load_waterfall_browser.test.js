// #21824: a cold Inbox starts independent script fetches together, without loading other pages.
process.env.CORAL_KEEP_START='1';
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {BASE}=require('./test_base');
(async()=>{
 const {client,Page,ev,waitFor,PRELOAD,install}=await connect();const {Network}=client;
 try{
  await Page.enable();await Network.enable();await Network.setCacheDisabled({cacheDisabled:true});
  await Network.emulateNetworkConditions({offline:false,latency:80,downloadThroughput:12500000,uploadThroughput:12500000});
  await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.navigate({url:BASE+'/inbox/needs'});await Page.loadEventFired();await install();
  await waitFor(`window.__coralReady?.parts.inboxListDrawn`,'first Inbox list drawn',30000);
  const samples=await ev(`(()=>{const all=performance.getEntriesByType('resource'),scripts=all.filter(e=>new URL(e.name).pathname.endsWith('.js')).map(e=>({name:new URL(e.name).pathname.split('/').pop(),start:e.startTime,end:e.responseEnd}));return{requests:all.length,scripts,ready:performance.now()};})()`);
  const ordered=samples.scripts.slice().sort((a,b)=>a.end-b.end);let chain=0,end=-1;
  for(const s of ordered)if(s.start>=end){chain++;end=s.end;}
  const result={requests:samples.requests,scripts:samples.scripts.length,lastScriptEnd:Math.round(Math.max(...samples.scripts.map(s=>s.end))),ready:Math.round(samples.ready),serialDepth:chain};
  console.log('INBOX_FIRST_LOAD '+JSON.stringify(result));
  if(process.env.CORAL_FIRST_LOAD_REPORT)require('node:fs').writeFileSync(process.env.CORAL_FIRST_LOAD_REPORT,JSON.stringify({result,scripts:samples.scripts},null,2));
  console.log('INBOX_SCRIPTS '+JSON.stringify(samples.scripts));
  assert.ok(!samples.scripts.some(s=>['team_artifacts_page.js','cost_dashboard.js'].includes(s.name)),'Needs you does not load Artifacts or Analytics page modules');
  assert.ok(chain<=30,'independent Inbox script fetches overlap; serial depth '+chain);
  await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('artifacts'))`);
  try{await waitFor(`!!document.querySelector('.inbox-artifacts-list table, .inbox-artifacts-list .empty-state-line')`,'Artifacts still renders on demand',15000);}catch(e){console.log('ARTIFACTS_STATE',await ev(`JSON.stringify({page:document.querySelector('#group-table-view')?.innerText,rows:!!document.querySelector('.inbox-artifacts-row'),path:location.pathname,scripts:performance.getEntriesByType('resource').filter(x=>x.name.includes('artifact')).map(x=>x.name)})`));throw e;}
  assert.ok(await ev(`performance.getEntriesByType('resource').some(e=>new URL(e.name).pathname.endsWith('/team_artifacts_page.js'))`),'Artifacts page loads after the folder opens');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
