// #8958: agreed review-pool contract, before the backend implementation is available.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {connect} = require('./agent_view_harness');
const {setTheme} = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await ev('window.__coralReady.then(()=>true)');
   await ev(`(()=>{const original=window.fetch;window.__review={subscriber_id:'reviewer',reviews_only:false,review_areas:[]};window.__writes=[];window.__failSave=false;
    window.fetch=(u,o={})=>{const url=new URL(String(u),location.origin);const json=(b,s=200)=>Promise.resolve(new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}}));
     if(url.pathname==='/api/board/review-ui/subscribers/reviewer/review-settings'){if(o.method!=='PUT')return json({},405);const body=JSON.parse(o.body);window.__writes.push(body);if(window.__failSave)return json({error:'Operator access required'},403);Object.assign(window.__review,body);return json(window.__review);}
     if(url.pathname==='/api/board/review-ui/subscribers')return json([window.__review]);
     if(url.pathname==='/api/board/review-ui/status')return json({agents:[{name:'reviewer',subscriber_id:'reviewer',availability:'available',agent_type:'codex'}]});
     if(url.pathname==='/api/board/review-ui/goals')return json({goals:[]});
     if(url.pathname==='/api/board/review-ui/tasks')return json({tasks:[{id:1,title:'Pool review',status:'review_pending',review_in_pool:true,review_areas:['ui']},{id:2,title:'Assigned review',status:'review_pending',reviewers:['Reviewer']},{id:3,title:'Build task',status:'pending'},{id:4,title:'Still held',status:'in_progress',review_requested:true}],total_open:4,total_completed:0});
     return original(u,o);};return true;})()`);
   await ev(`(async()=>{const S=window.__coralStatic||'/static/';const a=await import(S+'team_agents_page.js');const host=document.createElement('main');host.id='review-ui';host.style.cssText='position:fixed;inset:0;z-index:1000;background:var(--bg-primary);overflow:auto';document.body.append(host);const list=document.createElement('div');host.append(list);await a.showAgents(list,'review-ui');a.renderAgentPage(host,{name:'reviewer',subscriber_id:'reviewer',availability:'available',agent_type:'codex'},{onBack:()=>{}});return true;})()`);
   await waitFor(`!!document.querySelector('#review-ui [name=review_areas]')`,'Reviews only and Areas settings',3000);
   await waitFor(`!document.querySelector('#review-ui [name=review_areas]').disabled`,'settings loaded');
   const setAreas=async value=>ev(`(()=>{const i=document.querySelector('#review-ui [name=review_areas]');i.value=${JSON.stringify(value)};i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
   const save=()=>ev(`(()=>{[...document.querySelectorAll('#review-ui button')].find(b=>b.textContent==='Save settings').click();return true;})()`);
   await setAreas('bad/area');await save();assert.equal(await ev('window.__writes.length'),0,'invalid area never written');
   await setAreas('UI,go,ui');
   await ev(`(()=>{const b=document.querySelector('#review-ui [name=reviews_only]');b.click();window.__failSave=true;return true;})()`);
   await save();await waitFor(`document.getElementById('review-ui').textContent.includes('Only the Operator can change review settings.')`,'save refusal shown');
   assert.equal(await ev(`document.querySelector('#review-ui [name=review_areas]').value`),'UI,go,ui','refusal retains edit');
   await ev('window.__failSave=false');await save();await waitFor('window.__review.reviews_only===true','saved settings');
   assert.deepEqual(await ev('window.__review.review_areas'),['ui','go']);
   const dir=process.env.CORAL_SCREENSHOT_DIR;
   const shot=async name=>{if(dir){fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await setTheme(ev,theme);fs.writeFileSync(path.join(dir,`${name}-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}};
   await shot('review-settings');
   assert.deepEqual(await ev(`(() => { const s = document.querySelector('#review-ui section'); const h = s && s.querySelector('h3'); return { label: s && s.getAttribute('aria-label'), by: s && s.getAttribute('aria-labelledby') === (h && h.id), words: h && h.textContent }; })()`), { label: null, by: true, words: 'Review settings' }, 'the section is named by its heading, not by the same words twice (#9117)');
   const detail=await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'task_detail_html.js');const host=document.getElementById('review-ui');const wf={review_areas:['ui','<script>'],review_in_pool:true,reviewers_wanted:2,completion_review:{submitted_by:'author',released_by:'Coral'},review_rounds:[{reviewers:[{reviewer:'Ada <img>'}]}]};host.innerHTML=m.taskExtraHtml({status:'review_pending',workflow:wf});const pool=host.textContent;window.__reviewWorkflow=wf;wf.review_in_pool=false;host.innerHTML=m.taskExtraHtml({status:'review_pending',workflow:wf});return {pool,assigned:host.textContent,unsafe:!!host.querySelector('script,img')};})()`);
   assert.match(detail.pool,/In the pool/);assert.match(detail.pool,/ui/);assert.match(detail.pool,/Ada <img>/);assert.match(detail.assigned,/Ada <img>/);assert.doesNotMatch(detail.assigned,/Waiting for the Orchestrator/);assert.equal(detail.unsafe,false);
   await shot('review-assigned');
   await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'task_detail_html.js');window.__reviewWorkflow.review_in_pool=true;document.getElementById('review-ui').innerHTML=m.taskExtraHtml({status:'review_pending',workflow:window.__reviewWorkflow});return true;})()`);
   await shot('review-pool');
   await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'team_tasks_page.js');const host=document.getElementById('review-ui');host.replaceChildren();delete host.dataset.built;await m.showTasks(host,'review-ui');const select=host.querySelector('select[aria-label="Show tasks that are"]');select.value='needs_review';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`document.querySelectorAll('#review-ui tbody .dt-row').length===2`,'Needs review contains pool and assigned reviews only');
   const names=await ev(`[...document.querySelectorAll('#review-ui tbody .dt-primary')].map(x=>x.textContent)`);assert.ok(names.includes('Pool review')&&names.includes('Assigned review'));assert.ok(!names.includes('Still held'));
   assert.equal(await ev(`document.getElementById('review-ui').scrollWidth>innerWidth+1`),false,'phone fits');
   await shot('needs-review');
  }
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
