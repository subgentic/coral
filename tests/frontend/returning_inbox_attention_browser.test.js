// #16894: a bare returning start prioritizes attention, with asks/reviews before FYI goal notices.
process.env.CORAL_KEEP_START = '1';
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, nextFrame } = require('./helpers/wait');
const { seed } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const team='returning-'+Date.now().toString(36),problems=[];
 const shot=async n=>{const d=process.env.CORAL_RETURN_SHOTS;if(!d)return;require('node:fs').mkdirSync(d,{recursive:true});await nextFrame(ev);require('node:fs').writeFileSync(d+'/'+n+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.navigate({url:BASE+'/agents'});await Page.loadEventFired();await install();await coralReady(ev);await seed(ev,team);
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{localStorage.setItem('coral-last-place','/team/${team}');localStorage.removeItem('coral-inbox-needs-filters');const empty=sessionStorage.getItem('return-empty')==='1';const real=window.fetch.bind(window);const json=x=>Promise.resolve(new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}}));const ago=m=>new Date(Date.now()-m*60000).toISOString();window.fetch=(u,o)=>{const url=new URL(String(u&&u.url||u),location.origin);if(url.pathname==='/api/team-artifacts')return json(window.__reviewFixturePage(url,location.origin,{'${team}':empty?[]:[{id:'${'a'.repeat(64)}',name:'launch-review.md',available:true,tags:['for review'],produced_by:'Orchestrator',media_type:'text/markdown',size:120,created_at:ago(30),review_question:'Approve the launch plan?'}]}));if(url.pathname==='/api/operator-asks')return (sessionStorage.getItem('return-hold')==='1'?new Promise(resolve=>{window.__releaseReturn=()=>{sessionStorage.removeItem('return-hold');resolve()}}):Promise.resolve()).then(()=>json(empty?[]:[{board:'${team}',kind:'ask',id:9101,asker:'Orchestrator',text:'Choose the launch date',at:ago(20)}]));if(url.pathname==='/api/goals')return json({goals:!empty&&url.searchParams.get('state')==='done'?[1,2].map(id=>({id:9200+id,board_id:'${team}',state:'done',title:'Finished work '+id,created_by:'Operator',closed_by:'Orchestrator',closed_at:ago(1),closed_reason:'Work finished.'})):[]});return real(u,o)};})()`});
  for(const [width,height,mobile] of [[1440,900,false],[390,844,true]]){
   await Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile});await Emulation.setTouchEmulationEnabled({enabled:mobile});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await waitFor(`document.body.getAttribute('data-nav-tab')==='hub-inbox'||!!document.querySelector('#team-page-view:not([hidden])')`,'the startup destination',10000);
   try { await waitFor(`location.pathname==='/inbox/needs'`,'startup attention destination',10000); } catch { /* collect both widths before reporting */ }
   await shot('start-'+width);
   const path=await ev('location.pathname');if(path!=='/inbox/needs')problems.push(width+': returning start opens '+path+' instead of attention');
   await ev(`(async()=>{window.switchNavTab('hub-inbox');await(await import((window.__coralStatic||'/static/')+'inbox_tab.js')).selectInboxTab('needs');return true})()`);
   await waitFor(`document.getElementById('group-table-view').innerText.includes('Choose the launch date')&&document.getElementById('group-table-view').innerText.includes('Goal #9201')&&document.getElementById('group-table-view').innerText.includes('launch-review.md')`,'ask, review and FYI rows',10000);
   const rows=await ev(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].map(r=>r.textContent)`);
   const ask=rows.findIndex(t=>t.includes('Choose the launch date')),fyi=rows.findIndex(t=>t.includes('Goal #9201'));
   const review=rows.findIndex(t=>t.includes('launch-review.md'));if(review<0||review>=fyi)problems.push(width+': review must precede FYI: '+JSON.stringify(rows));
   if(ask<0||fyi<0||ask>=fyi)problems.push(width+': ask must precede FYI: '+JSON.stringify(rows));
   await ev(`(()=>{for(const b of document.querySelectorAll('.notification-toast-close'))b.click();document.querySelector('.launch-disclosure-dismiss')?.click();return true})()`);await shot('inbox-'+width);
  }
  await Emulation.setDeviceMetricsOverride({width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await Page.navigate({url:BASE+'/team/'+team});await Page.loadEventFired();await install();await coralReady(ev);
  await waitFor(`!!document.querySelector('#team-page-view:not([hidden])')`,'explicit team link');
  assert.equal(await ev('location.pathname'),'/team/'+team,'explicit team links retain their destination despite pending attention');
  await ev(`sessionStorage.setItem('return-hold','1')`);
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await waitFor(`typeof window.__releaseReturn==='function'`,'attention read held for user navigation');
  await ev(`(async()=>{await(await import((window.__coralStatic||'/static/')+'nav.js')).go({view:'agents'});window.__releaseReturn();await(await import((window.__coralStatic||'/static/')+'inbox_sidebar.js')).startupNeedsCount();return true})()`);
  await nextFrame(ev);assert.equal(await ev('location.pathname'),'/agents','late startup attention cannot undo user navigation');
  await ev(`sessionStorage.setItem('return-empty','1')`);
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
  await waitFor(`location.pathname==='/team/${team}'&&!!document.querySelector('#team-page-view:not([hidden])')`,'empty Inbox restores remembered team',10000);
  assert.deepEqual(problems,[]);console.log('PASS returning start prioritizes attention and asks lead FYI');
 }finally{await removeBoards(ev,[team]).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exit(1)});
