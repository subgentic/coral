// #22094 approved v19: real Inbox mounts; invented sources, asks and files.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {connect}=require('./agent_view_harness'),{coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const {Input}=client;try{
const errors=[];client.Runtime.exceptionThrown(e=>errors.push(e.exceptionDetails.exception?.description||e.exceptionDetails.text));await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
for(const width of [1280,390]){
 await Emulation.setDeviceMetricsOverride({width,height:1500,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
 await ev(`(async()=>{
 localStorage.removeItem('coral-inbox-group-mode');localStorage.removeItem('coral-inbox-group-review-goal');localStorage.removeItem('coral-needs-question-read');localStorage.removeItem('coral-inbox-needs-filters');
 const real=fetch,now=Date.now(),ago=n=>new Date(now-n*60000).toISOString();window.__requests=[];
 window.__asks=[{id:901,kind:'ask',board:'Shop site',asker:'Frontend Dev',text:'@Operator Guest checkout: keep the phone number field?\\nThe approved mock has no phone number, but the courier asks for one on large orders.',at:ago(360),goal_id:41,goal_title:'Checkout redesign: one page, guest checkout first',task_id:412,task_title:'Guest checkout: address form',buttons:[{id:1,label:'Keep it, optional',action:'reply',state:'pending'},{id:2,label:'Remove it',action:'reply',state:'pending'}]},{id:902,kind:'ask',board:'Docs team',asker:'Orchestrator',text:'Two image questions before the help-centre article goes live\\n1. Two screenshots showed order totals. Is the covered version OK?\\n2. Keep the test address?',at:ago(1200),buttons:[]}];
 window.__files=['checkout-one-page-mock.html','guest-checkout-copy.md','address-form-screens.png','checkout-test-report.md','spring-sale.md'].map((name,i)=>({id:String(i+1).repeat(64),uri:'coral://artifacts/'+String(i+1).repeat(64),name,media_type:i===0?'text/html':i===2?'image/png':'text/markdown',goal_id:i===4?38:41,goal_title:i===4?'Spring sale emails (three sends)':'Checkout redesign: one page, guest checkout first',task_id:414,task_title:'Payment step',produced_by:['Designer','Writer','Frontend Dev','QA','Writer'][i],created_at:ago([120,300,1440,1500,2000][i]),tags:['for review','read'],available:true,version:i===0?3:1,review_question:['Is this the checkout you want?','Are these words right for a first-time buyer?','Approve the address form as built?','12 of 12 checks pass. OK to land?','Approve the email?'][i]}));
 window.fetch=(u,o={})=>{const p=String(u);window.__requests.push([p,o.method||'GET']);
 if(p.includes('/api/operator-asks'))return Response.json(window.__asks);
 if(p.includes('/api/board/projects'))return Response.json([{project:'Shop site'},{project:'Docs team'}]);
 if(p.includes('/api/team-artifacts'))return Response.json(window.__reviewFixturePage(p,location.href,{'Shop site':window.__files}));
 if(/\\/api\\/goals(?:\\?|$)/.test(p))return Response.json({goals:[{id:41,board_id:'Shop site',title:'Checkout redesign: one page, guest checkout first',state:'active',rollup:{total:9,done:4,active:5},updated_at:ago(120)},{id:38,board_id:'Shop site',title:'Spring sale emails (three sends)',state:'active',rollup:{total:5,done:2,active:3},updated_at:ago(2000)}]});
 if(/\\/chat\\?/.test(p))return Response.json({messages:[],total:0,prompt_options:{question:'Run the command?',ask_id:'permission-1',options:[{n:1,label:'Allow',action:'select'},{n:2,label:'Deny',action:'select'}]}});
 return real(u,o)};
 const entry=window.__m.entry.bind(window.__m);window.__m.entry=a=>({...entry(a),waiting_for_input:true,waiting_kind:'permission',waiting_summary:a.name==='Writer'?'Wants to run: help-centre/shared/footer.md':'Wants to run: npm install @shopkit/card-form',waiting_since:ago(a.name==='Writer'?31:4),board_task:{id:414,title:'Payment step: saved cards',status:'in_progress',goal_id:41,goal_title:'Checkout redesign: one page, guest checkout first'}});
 window.__m.add('Frontend Dev','F',4,{sleeping:false,board_project:'Shop site',session_id:'permission-agent'});window.__m.add('Writer','W',5,{sleeping:false,board_project:'Docs team',session_id:'writer-permission'});
 })()`);
 await waitFor(`(window.__qaState?.liveSessions||[]).length===2`,'permission source');
 await ev(`window.__qaState.liveSessions=window.__qaState.liveSessions.map(s=>({...s,...window.__m.entry(window.__m.agents[s.session_id])}));import((window.__coralStatic||'/static/')+'needs_question_read.js').then(m=>m.markQuestionRead(window.__qaState.liveSessions.find(s=>s.name==='Writer')));window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs'))`);
 try{await waitFor(`[...document.querySelectorAll('.needs-ledger .nl-file')].filter(n=>n.getClientRects().length).length===4`,'expanded question goal has four review files',15000);}catch(e){console.log(JSON.stringify({errors,dom:await ev(`document.querySelector('#group-table-view')?.textContent.slice(0,5000)`),requests:await ev('window.__requests')}));throw e;}
 assert.ok(await ev(`(()=>{const h=document.querySelector('.needs-ledger-toolbar .inbox-folder-head');return !h||h.getBoundingClientRect().width<=1})()`),'legacy title and duplicate count stay visually hidden');
 await ev(`document.querySelector('.needs-ledger-toolbar .skip-link').click();true`);assert.ok(await ev(`document.activeElement.matches('.nl-row')`),'skip link reaches new rows');
 assert.match(await ev(`document.querySelector('.nl-summary').textContent`),/9 items.*3 new/,'summary counts actual unread requests and read files');
 assert.deepEqual(await ev(`[...document.querySelectorAll('.nl-section')].map(n=>n.firstChild.textContent)`),['Permission prompts','By goal']);
 assert.deepEqual(await ev(`[...document.querySelectorAll('.nl-group-toggle')].map(n=>n.textContent)`),['#41 Checkout redesign: one page, guest checkout first','Not tied to a goal','#38 Spring sale emails (three sends)']);
 assert.equal(await ev(`document.querySelector('.nl-group-toggle').getAttribute('aria-expanded')`),'true');
 assert.equal(await ev(`[...document.querySelectorAll('.nl-group-toggle')].at(-1).getAttribute('aria-expanded')`),'false');
 assert.equal(await ev(`document.querySelector('.nl-permission .nl-icon').textContent`),'lock');assert.equal(await ev(`document.querySelector('.nl-question .nl-icon').textContent`),'waving_hand');
 assert.ok(await ev(`[...document.querySelectorAll('.nl-question-box')].every(n=>!n.textContent.includes('@Operator'))`));
 assert.match(await ev(`document.querySelector('.nl-question .nl-meta a[href*="tasks"]').getAttribute('href')`),/412/);
 assert.equal(await ev(`document.querySelectorAll('.nl-group-body .goal-ledger-tasks').length`),0,'Needs you has no task list');
 await waitFor(`!document.querySelector('.nl-permission .inbox-arming')`,'permission guard completes before screenshot');
 if(width===1280){await ev(`document.querySelector('.nl-question').focus({preventScroll:true});true`);const p=await ev(`(()=>{const r=document.querySelectorAll('.nl-permission')[1].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await Input.dispatchMouseEvent({type:'mouseMoved',x:p.x,y:p.y});}else await ev(`document.querySelector('.nl-more-toggle').click();true`);
 for(const theme of ['dark','light']){await ev(`document.documentElement.dataset.theme='${theme}';document.fonts.ready.then(()=>${framesJs(2)})`);assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow '+width+'/'+theme);if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/build-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot()).data,'base64'));}}
 await ev(`document.documentElement.style.fontSize='32px';${framesJs(2)}`);
 assert.ok(await ev(`[document.querySelector('.needs-ledger'),document.querySelector('.needs-ledger-toolbar .list-bar-search-row')].every(n=>n.scrollWidth<=n.clientWidth+1)`),'new list and toolbar fit at 200% text');
 await ev(`document.documentElement.style.fontSize='';${framesJs(2)}`);
 if(width===390){assert.ok(await ev(`[...document.querySelectorAll('.needs-ledger .nl-actions button')].filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible').every(n=>n.getBoundingClientRect().height>=44)`),'all visible phone answers have 44px targets');assert.equal(await ev(`document.querySelector('.nl-more .nl-menu').textContent.split('Dismiss').length-1`),1,'permission menu has only one Dismiss');await ev(`document.querySelector('.nl-more').open=false;true`);assert.equal(await ev(`getComputedStyle(document.querySelector('.nl-question .nl-actions')).visibility`),'visible');const hit=await ev(`(()=>{const b=document.querySelector('.nl-more-toggle'),r=b.getBoundingClientRect();return {w:r.width,h:r.height}})()`);assert.ok(hit.w>=44&&hit.h>=44);await ev(`document.querySelector('.nl-more-toggle').focus();document.querySelector('.nl-more-toggle').click();true`);assert.equal(await ev(`document.querySelector('.nl-more').open`),true);await Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await Input.dispatchKeyEvent({type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await ev(`document.querySelector('.nl-more').open`),false);await ev(`document.querySelector('.nl-selection-mode').click();true`);}
 await ev(`document.querySelector('.nl-question .nl-check').click();true`);assert.match(await ev(`document.querySelector('.nl-summary').textContent`),/1 selected/);await ev(`[...document.querySelectorAll('.nl-summary button')].find(b=>b.textContent==='Mark as read').click();true`);
 await waitFor(`!document.querySelector('.nl-question')?.querySelector('.nl-new')`,'reading first question clears its New tag');
 await ev(`document.querySelector('.nl-group-toggle').click();true`);assert.equal(await ev(`document.querySelector('.nl-group-body').hidden`),true);await ev(`document.querySelector('.nl-group-toggle').click();true`);assert.equal(await ev(`document.querySelector('.nl-group-body').hidden`),false);
 await ev(`document.querySelector('.inbox-fold-all').click();true`);assert.ok(await ev(`[...document.querySelectorAll('.nl-group-body')].every(n=>!n.hidden)`),'fold-all expands new goal groups');
 await ev(`document.querySelector('.inbox-fold-all').click();true`);assert.ok(await ev(`[...document.querySelectorAll('.nl-group-body')].every(n=>n.hidden)`),'fold-all collapses new goal groups');
 await ev(`document.querySelector('.inbox-fold-all').click();true`);
 await ev(`(()=>{const s=document.querySelector('.nl-visible-group select');s.value='none';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await waitFor(`document.querySelector('.needs-ledger')&&!document.querySelector('.nl-group-toggle')`,'None uses flat newest-first rows');
 assert.ok(await ev(`(()=>{const at=[...document.querySelectorAll('.nl-row .nl-when')].map(t=>Date.parse(t.dateTime));return at.every((n,i)=>!i||at[i-1]>=n)})()`),'flat rows keep strict time order');
 assert.equal(await ev(`document.querySelectorAll('.nl-row').length`),9,'flat mode retains every underlying record');
 await ev(`window.__asks[0].may_no_longer_apply='task_completed';import((window.__coralStatic||'/static/')+'operator_asks.js').then(m=>m.refreshOperatorAsks(true))`);
 try { await waitFor(`document.querySelector('.needs-ledger')?.textContent.includes('The linked task is finished.')`,'stale task caution survives the redesigned question'); } catch(e) { console.log(JSON.stringify(await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'operator_asks.js');return {asks:m.operatorAsks(),fixture:window.__asks,words:document.querySelector('.needs-ledger')?.textContent}})()`))); throw e; }

 await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'operator_ask_dialog.js');await m.openAskDialog(window.__asks[1]);})()`);
 await waitFor(`document.querySelector('.inbox-ask-dialog[open]')`,'question opens from another view');
 assert.ok(await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'needs_question_read.js');return m.questionWasRead({operatorAsk:window.__asks[1]})})()`),'opening a question outside the list clears New');
 await ev(`document.querySelector('.inbox-ask-dialog').close();true`);
 assert.ok(await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'needs_question_read.js');const a={operatorAsk:{id:99,board:'same-team',at:'2026-11-28T00:00:00Z',text:'A'},server:'one'};m.markQuestionRead(a);return m.questionWasRead(a)&&!m.questionWasRead({...a,server:'two'})&&!m.questionWasRead({...a,operatorAsk:{...a.operatorAsk,text:'Changed'}})})()`),'read marks bind source and request version');

 }
assert.deepEqual(errors,[],'no browser exceptions');
console.log('PASS approved Needs you v19: pinned prompts, newest groups, source links, New, bulk read, phone actions and both themes');
}finally{await client.close()}})().catch(e=>{console.error(e);process.exit(1)});
