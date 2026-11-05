// #13580: one row per publisher/name, latest approved plus a pending approval entry; full history in detail.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
const row=(version,status,publisher='Designer')=>({id:(publisher==='Designer'?String(version):'b').repeat(32),name:'testing-on-the-mac-mini',version,status,digest:String(version).repeat(64),description:`${publisher} description v${version}`,publisher_kind:'agent',publisher_agent:publisher,publisher_team:'alpha',has_scripts:false,not_reviewable:false,file_count:1,created_at:`2026-11-0${version}T10:00:00Z`,decided_at:status==='approved'?`2026-11-0${version}T11:00:00Z`:''});
const ROWS=[row(5,'rejected'),row(4,'pending'),row(3,'approved'),row(2,'approved'),row(1,'approved'),row(2,'approved','Other publisher')];
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const list=()=>ev(`[...document.querySelectorAll('#skills-view tbody tr')].map(r=>r.textContent)`);
 const show=()=>ev(`import((window.__coralStatic||'/static/')+'skills_tab.js').then(m=>m.showSkillsTab()).then(()=>true)`);
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await ev(`(()=>{const real=window.fetch,rows=${JSON.stringify(ROWS)},json=b=>Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}));window.fetch=(u,o)=>{const p=new URL(String(u),location.href);if(p.pathname==='/api/skills')return json({skills:rows.filter(r=>!p.searchParams.get('status')||r.status===p.searchParams.get('status'))});const hit=rows.find(r=>p.pathname==='/api/skills/'+r.id);if(hit)return json({skill:hit,files:[{path:'SKILL.md',size:20,kind:'instructions',sha256:'f'.repeat(64)}],contents:{'SKILL.md':'Instructions for version '+hit.version},warnings:[],hosts:[]});return real(u,o);};return true;})()`);
  await ev(`window.switchNavTab('skills');true`);
  await show();
  await waitFor(`document.querySelector('#skills-view tbody tr')`,'skills list');
  if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/skills-1280.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
  assert.equal((await list()).length,2,'one row per skill and publisher');
  const texts=await list();assert.ok(texts.some(t=>t.includes('Designer description v3')&&t.includes('v3')&&t.includes('Approved')&&t.includes('v4 waiting')),JSON.stringify(texts));
  assert.ok(texts.some(t=>t.includes('Other publisher description v2')), 'same name from another publisher stays separate');
  await ev(`document.querySelector('#skills-view .dt-sort[data-key=version]').click();true`);
  assert.match((await list())[0],/Other publisher/,'version ascending sorts the displayed approved versions');
  await ev(`document.querySelector('#skills-view .dt-sort[data-key=version]').click();true`);
  assert.match((await list())[0],/Designer description v3/,'version descending works');
  await ev(`[...document.querySelectorAll('#skills-view button')].find(b=>b.textContent==='v4 waiting').click();true`);
  await waitFor(`document.querySelector('#skills-view h2')?.textContent.includes('version 4')`,'pending version detail');
  assert.ok(await ev(`[...document.querySelectorAll('#skills-view button')].some(b=>b.textContent==='Approve')`),'pending approval remains actionable');
  await ev(`document.querySelector('#skills-view details').open=true;true`);
  const history=await ev(`[...document.querySelectorAll('#skills-view details button')].map(b=>b.textContent)`);
  assert.equal(history.length,5,'all versions of only this publisher in history');
  await ev(`[...document.querySelectorAll('#skills-view details button')].find(b=>/^v1 /.test(b.textContent)).click();true`);
  await waitFor(`document.querySelector('#skills-view h2')?.textContent.includes('version 1')`,'older version opened');
  assert.match(await ev(`document.querySelector('.skills-file-text').textContent`),/version 1/);
  await show();
  await ev(`document.querySelector('#skills-view select[aria-label=Show]').value='pending';document.querySelector('#skills-view select[aria-label=Show]').dispatchEvent(new Event('change'));true`);
  await waitFor(`document.querySelectorAll('#skills-view tbody tr').length===1`,'pending filter');assert.match((await list())[0],/v4/);
  await ev(`document.querySelector('#skills-view select[aria-label=Show]').value='';document.querySelector('#skills-view select[aria-label=Show]').dispatchEvent(new Event('change'));true`);
  await waitFor(`document.querySelectorAll('#skills-view tbody tr').length===2`,'all filter');
  await ev(`import((window.__coralStatic||'/static/')+'skills_tab.js').then(m=>m.filterSkills('other publisher'))`);
  assert.equal((await list()).length,1,'search still filters grouped rows');assert.match((await list())[0],/Other publisher/);
  console.log('PASS grouped skills: latest approved, pending action, publisher isolation, history and search/filter');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
