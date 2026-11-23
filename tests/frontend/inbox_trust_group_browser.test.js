// #16615: one lasting folder decision, with fresh checks for every member.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {coralReady}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
const FOLDER='/Users/qa/work/trust-group';
const MENU={ask_id:'trust-ask',unnumbered:true,question:'Quick safety check',trust_offer:true,trust_folder:FOLDER,options:[{n:1,label:'No, exit',action:'select'},{n:2,label:'Yes, I trust this folder',action:'select'}]};
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const theme of ['light','dark'])for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(()=>{document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});window.__trustMenus={a:${JSON.stringify(MENU)},b:${JSON.stringify({...MENU,ask_id:'trust-b'})},c:${JSON.stringify({...MENU,ask_id:'trust-c'})}};window.__trustPosts=[];const real=window.fetch;window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;const json=b=>Promise.resolve(Response.json(b));if(p.endsWith('/chat')){const name=decodeURIComponent(p.split('/').at(-2));const body={messages:[],prompt_options:window.__trustMenus[name]};return window.__trustGate?window.__trustGate.then(()=>json(body)):json(body)}if(p.endsWith('/answer-prompt')&&o.method==='POST'){window.__trustPosts.push(JSON.parse(o.body));return json({ok:true})}return real(u,o)};const entry=window.__m.entry.bind(window.__m);window.__m.entry=a=>({...entry(a),working_directory:${JSON.stringify(FOLDER)},waiting_for_input:true,waiting_kind:'permission',waiting_summary:'Quick safety check',waiting_since:'group-'+${JSON.stringify(theme+width)}});for(const name of ['a','b','c'])window.__m.add(name,name,4,{sleeping:false,agent_type:'claude',board_project:'team-group',session_id:name});window.switchNavTab('hub-inbox');return true})()`);
   await waitFor(`window.__qaState?.liveSessions?.length===3`,'three waiting agents');
   await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>{m.updateInboxTab();return m.selectInboxTab('needs')}).then(()=>true)`);
   await waitFor(`document.querySelectorAll('#group-table-view .inbox-trust-group').length===1`,'one trust card per recorded folder');
   assert.ok(await ev(`document.querySelector('.inbox-trust-group').textContent.includes(${JSON.stringify(FOLDER)})`),'full recorded folder visible');
   assert.ok(await ev(`document.querySelector('.inbox-trust-group').textContent.includes('3 agents')`),'agent count visible');
   assert.ok(await ev(`document.querySelector('.inbox-trust-group').textContent.includes('lasting')`),'lasting grant explained');
   const target=await ev(`(()=>{const b=document.querySelector('.inbox-trust-group .inbox-trust-go');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {primary:b.classList.contains('btn-primary'),height:r.height,right:r.right}})()`);
   assert.ok(target.primary&&target.height>=44&&target.right<=width,'primary touch target fits');
   if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/trust-group-${width}-${theme}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   // The second member moved to another menu, the third now names another folder.
   await ev(`window.__trustMenus.b={...window.__trustMenus.b,ask_id:'bash',unnumbered:false,trust_offer:false,options:[{n:1,label:'Yes'},{n:2,label:'No'}]};window.__trustMenus.c={...window.__trustMenus.c,trust_folder:'/Users/qa/work/other'};window.__trustGate=new Promise(r=>{window.__trustRelease=r});document.querySelector('.inbox-trust-group .inbox-trust-go').click();true`);
   // The list is drawn again while the answers are being checked (any refresh does this): the card is made anew and must not lose the outcome of the click in flight (#20865).
   await ev(`window.__trustCell=document.querySelector('.inbox-trust-group');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.updateInboxTab()).then(()=>true)`);
   await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
   await waitFor(`(()=>{const c=document.querySelector('#group-table-view .inbox-trust-group');return !!c&&c!==window.__trustCell&&!c.querySelector('.inbox-trust-go:not([disabled])')})()`,'the card drawn again during the click is a new one and offers no second answer');
   await ev(`window.__trustRelease();true`);
   await waitFor(`document.querySelector('.inbox-trust-results')?.textContent.includes('Not answered')`,'changed members reported');
   const posts=await ev(`window.__trustPosts`);assert.equal(posts.length,1,'only unchanged member answered');assert.equal(posts[0].session_id,'a');assert.equal(posts[0].trust_folder,FOLDER);assert.equal(posts[0].ask_id,'trust-ask');
  }
  console.log('PASS grouped trust with fresh per-agent checks at desktop/phone in both themes');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
