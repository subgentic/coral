// #13818: real team targets from independent row links; never answer/open/read the question.
const assert=require('node:assert/strict');const fs=require('node:fs');
const {connect}=require('./agent_view_harness');const {removeBoards}=require('./helpers/board_cleanup');
const {setupHubWorld}=require('./helpers/hub_world');
const {coralReady}=require('./helpers/wait');const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {Input}=client;
 const board='subject-links-'+Date.now().toString(36),failures=[];let goal,task,remoteGoal,remoteTask;const remoteBoard='remote-'+board;
 const api=(method,path,body)=>ev(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json()}))`);
 const shot=async name=>{const d=process.env.CORAL_SCREENSHOT_DIR;if(d){fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+'/'+name+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}};
 const load=async()=>{await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');};
 const question=async()=>{
  await ev(`(()=>{window.__subjectWrites=[];const orig=window.fetch.bind(window);window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(p==='/api/operator-asks')return Promise.resolve(new Response(JSON.stringify([{board:${JSON.stringify(board)},board_label:'Subject team',kind:'ask',id:441,asker:'Orchestrator',goal_id:${goal},goal_title:'Actual subject goal',task_id:${task},task_title:'Actual subject task',text:'@Operator Please check the goal and task before answering.',at:new Date().toISOString()}]),{headers:{'Content-Type':'application/json'}}));if(o.method&&o.method!=='GET'&&p!=='/api/tracking/event')window.__subjectWrites.push({path:p,method:o.method});return orig(u,o);};return true;})()`);
  await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
  await waitFor(`!!document.querySelector('.inbox-review-earlier')`,'subject row');
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:'window.__subjectDirectFetch=window.fetch.bind(window);'});await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await load();
  assert.equal((await api('POST',`/api/board/${board}/subscribe`,{subscriber_id:'orch',job_title:'Orchestrator',session_name:board})).status,200);
  const g=await api('POST',`/api/board/${board}/goals`,{subscriber_id:'Operator',title:'Actual subject goal',outcome:'Read the correct goal',done_when:'Opened without answering'});assert.equal(g.status,201);goal=g.data.id;
  const t=await api('POST',`/api/board/${board}/tasks`,{created_by:'orch',title:'Actual subject task',body:'Target body for the real team task',priority:'medium',goal_id:goal});assert.equal(t.status,201);task=t.data.id;
  for(const [width,height,mobile] of [[1280,900,false],[800,900,false],[390,900,true],[430,900,true],[844,390,true]])for(const theme of ['light','dark']){
   await Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile});await Emulation.setTouchEmulationEnabled({enabled:mobile});await load();await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});true`);await question();
   if(theme==='light'&&width!==800)await shot('subjects-'+width);
   const links=await ev(`[...document.querySelectorAll('.inbox-review-earlier a')].map(a=>({text:a.textContent,href:a.getAttribute('href'),weight:getComputedStyle(a).fontWeight,height:a.getBoundingClientRect().height,width:a.getBoundingClientRect().width,name:a.getAttribute('aria-label')}))`);
   if(links.length!==2){failures.push(width+' '+theme+': expected two bold row links, got '+JSON.stringify(links));continue;}
   assert.ok(links.every(a=>Number(a.weight)>=600&&a.name),JSON.stringify(links));
   const visuals=await ev(`(()=>{const a=document.querySelector('.inbox-review-earlier a'),row=a.closest('tr');const rgb=s=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=s;c.fillRect(0,0,1,1);const a=[...c.getImageData(0,0,1,1).data];return [a[0],a[1],a[2],a[3]/255];};const lum=c=>c.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);const measure=read=>{row.classList.toggle('dt-read',read);row.classList.toggle('dt-unread',!read);let n=a,layers=[];while(n){layers.push(rgb(getComputedStyle(n).backgroundColor));n=n.parentElement;}let bg=[255,255,255];for(const c of layers.reverse()){const alpha=c[3]??1;bg=bg.map((v,i)=>c[i]*alpha+v*(1-alpha));}const f=lum(rgb(getComputedStyle(a).color)),b=lum(bg);return {read,weight:getComputedStyle(a).fontWeight,contrast:(Math.max(f,b)+.05)/(Math.min(f,b)+.05)};};const results=[measure(false),measure(true)];measure(false);return results;})()`);
   assert.ok(visuals.every(v=>Number(v.weight)>=600&&v.contrast>=4.5),JSON.stringify(visuals));if(mobile)assert.ok(links.every(a=>a.height>=44&&a.width>=44),JSON.stringify(links));
   if(mobile&&width<=760){
    const slot=await ev(`(()=>{const m=document.querySelector('.inbox-ask-subject-links'),r=m.parentElement,n=r.querySelector('.inbox-review-name'),f=r.querySelector('.inbox-review-from'),w=r.querySelector('.inbox-review-wait');const b=e=>e.getBoundingClientRect();return {direct:r.classList.contains('inbox-title-first'),grid:getComputedStyle(r).display,width:b(m).width,parentWidth:b(r).width,top:b(m).top,after:Math.max(b(n).bottom,b(f).bottom,b(w).bottom),left:b(m).left,parentLeft:b(r).left,right:b(m).right,parentRight:b(r).right};})()`);
    assert.ok(slot.direct&&slot.grid==='grid'&&slot.width>=slot.parentWidth-1&&slot.top>=slot.after-1&&slot.left>=slot.parentLeft-1&&slot.right<=slot.parentRight+1,'third full-width slot: '+JSON.stringify(slot));
   }
   for(const kind of ['goal','task']){
    const id=kind==='goal'?goal:task;
    await ev(`document.querySelector('.inbox-review-earlier a[data-subject-kind="${kind}"]').focus();true`);
    if(kind==='goal'){const p=await ev(`(()=>{const a=document.querySelector('.inbox-review-earlier a[data-subject-kind="goal"]'),r=a.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);await Input.dispatchMouseEvent({type:'mousePressed',...p,button:'left',clickCount:1});await Input.dispatchMouseEvent({type:'mouseReleased',...p,button:'left',clickCount:1});}else{await Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
    await waitFor(`location.pathname===${JSON.stringify('/team/'+board+'/'+kind+'s/'+id)}`,'team '+kind+' URL');
    await waitFor(kind==='goal'?`document.querySelector('#team-panel-goals #goals-detail-title')?.textContent==='Actual subject goal'`:`document.querySelector('#team-panel-item #team-task-title')?.textContent.includes('Actual subject task')`,'actual '+kind+' content',15000);
    assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog')`),false,'link does not open question');
    assert.deepEqual(await ev('window.__subjectWrites'),[],'link performs no read/answer mutation');
    await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);await waitFor(`document.querySelectorAll('.inbox-review-earlier a').length===2`,'row returns');
   }
   await ev(`document.querySelector('.inbox-ask-name').click();true`);await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`,'rest of row still opens question');await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn').click();true`);
  }
  assert.equal((await api('POST',`/api/board/${remoteBoard}/subscribe`,{subscriber_id:'remote-orch',job_title:'Orchestrator',session_name:remoteBoard})).status,200);
  const rg=await api('POST',`/api/board/${remoteBoard}/goals`,{subscriber_id:'Operator',title:'Remote source goal',outcome:'Source retained',done_when:'Right source'});assert.equal(rg.status,201);remoteGoal=rg.data.id;
  const rt=await api('POST',`/api/board/${remoteBoard}/tasks`,{created_by:'remote-orch',title:'Remote source task',body:'This is the remote dataset',goal_id:remoteGoal});assert.equal(rt.status,201);remoteTask=rt.data.id;
  await setupHubWorld({client,Page,Emulation,width:1280,height:900,mobile:false,inbox:'native',needs:true,hubPages:true});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});await load();
   await ev(`(()=>{window.__sourceReads=[];window.__subjectWrites=[];const old=window.fetch.bind(window);window.fetch=(u,o={})=>{const p=new URL(String(u),location.href);if(p.pathname.endsWith('/api/operator-asks'))return Promise.resolve(new Response(JSON.stringify(p.pathname.includes('/remote/m1/')?[{board:${JSON.stringify(board)},board_label:'Source team',kind:'ask',id:442,asker:'Remote orchestrator',goal_id:${remoteGoal},goal_title:'Remote source goal',task_id:${remoteTask},task_title:'Remote source task',text:'@Operator Keep the computer with each reference.',at:new Date().toISOString()}]:[]),{headers:{'Content-Type':'application/json'}}));if(o.method&&o.method!=='GET'&&p.pathname!=='/api/tracking/event')window.__subjectWrites.push({path:p.pathname,method:o.method});const prefix='/api/remote/m1/api/board/'+${JSON.stringify(board)};if(p.pathname.startsWith(prefix)){window.__sourceReads.push(p.pathname);return window.__subjectDirectFetch('/api/board/'+${JSON.stringify(remoteBoard)}+p.pathname.slice(prefix.length)+p.search,o);}return old(u,o);};return true;})()`);
   await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);await waitFor(`document.querySelectorAll('.inbox-review-earlier a').length===2`,'remote subject links');
   for(const kind of ['goal','task']){
    const id=kind==='goal'?remoteGoal:remoteTask;
    assert.equal(await ev(`document.querySelector('.inbox-review-earlier a[data-subject-kind="${kind}"]').getAttribute('href')`),'/team/@m1/'+board+'/'+kind+'s/'+id);
    await ev(`document.querySelector('.inbox-review-earlier a[data-subject-kind="${kind}"]').click();true`);
    await waitFor(kind==='goal'?`document.querySelector('#team-panel-goals #goals-detail-title')?.textContent==='Remote source goal'`:`document.querySelector('#team-panel-item #team-task-title')?.textContent.includes('Remote source task')`,'real source-scoped team '+kind,15000);
    assert.ok(await ev(`window.__sourceReads.some(p=>p.endsWith('/${kind}s/${id}'))`),'computer carried to target API');assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog')`),false);assert.deepEqual(await ev('window.__subjectWrites'),[]);
    await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);await waitFor(`document.querySelectorAll('.inbox-review-earlier a').length===2`,'remote row returns');
   }
  }
  assert.deepEqual(failures,[],'bold linked subjects on every layout/theme');
  console.log('PASS independent subject links: real team goal/task, keyboard, row isolation, phone targets and both themes');
 }finally{await removeBoards(ev,[board,remoteBoard]).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
