// #14312: explicit removal hides only the current dismissed request and sends no input.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const teams=[];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width===390 });
   await Page.navigate({ url: BASE+'/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
   const team='retained-wait-'+Date.now().toString(36);teams.push(team);
   await ev(`fetch('/api/board/'+${JSON.stringify(team)}+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Retained agent',job_title:'Developer'})}).then(r=>r.ok)`);
   await ev(`(()=>{localStorage.removeItem('coral-inbox-needs-filters');const real=window.fetch;window.__waitWrites=[];window.__m.add('retained-agent','R',3,{sleeping:false});const row=window.T.state.liveSessions.find(s=>s.session_id==='retained-agent-id');Object.assign(row,{board_project:${JSON.stringify(team)},waiting_for_input:true,wait_ignored:true,waiting_kind:'permission',waiting_summary:'Browser permission',waiting_since:'2026-11-07T01:00:00Z'});window.__retained=row;window.T.state.liveSessions.push({...row,server:'box-2',session_id:'remote-retained-id',name:'remote-retained',display_name:'Remote retained agent'});window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(o.method&&o.method!=='GET')window.__waitWrites.push(p);if(p==='/api/board/'+${JSON.stringify(team)}+'/status'&&window.__failAvailability){window.__availabilityFailed=true;return Promise.resolve(Response.json({error:'unavailable'},{status:503}));}if(p==='/api/board/'+${JSON.stringify(team)}+'/status')return Promise.resolve(Response.json({agents:[{session_id:'retained-agent-id',availability:${JSON.stringify(width===1280?'needs_input':'waiting')}}]}));if(p==='/api/sessions/live')return Promise.resolve(Response.json(window.T.state.liveSessions));return real(u,o)};window.T.render.renderLiveSessions(window.T.state.liveSessions);window.__opened=null;window.selectLiveSession=(...args)=>{window.__opened=args};return true})()`);
   // Pin wait_ignored directly before any removal: every other predicate is eligible.
   assert.deepEqual(await ev(`import((window.__coralStatic||'/static/')+'dismiss_wait.js').then(m=>{const request={session_id:'guard-pin',name:'guard-pin',agent_type:'claude',server:'local',waiting_for_input:true,wait_ignored:true,wait_removed:false,sleeping:false,archived:false,waiting_since:'2026-11-07T01:00:00Z',waiting_kind:'permission'};return[m.canRemoveWait(request),m.canRemoveWait({...request,wait_ignored:false})]})`),[true,false],'wait_ignored alone gates an otherwise eligible request');
   const count=()=>ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.waitingCount())`);
   await ev(`(()=>{const real=window.fetch;window.__removeStatus=200;window.__removeCalls=[];window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;if(p.endsWith('/dismiss-wait')){const body=JSON.parse(o.body);window.__removeCalls.push(body);if(window.__removeStatus!==200)return Promise.resolve(Response.json({error:window.__removeStatus===409?'Dismiss it first':'Only the owner may remove it'},{status:window.__removeStatus}));window.__retained.wait_removed=true;return Promise.resolve(Response.json({removed:true}));}return real(u,o)};return true})()`);
   const inbox=async()=>{await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);await waitFor(`!!document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"]')`,'current retained row');};
   const activate=async(expression,keyboard=false)=>{
    const point=await ev(`(()=>{const b=${expression};b.scrollIntoView({block:'center'});b.focus();if(window.__staleChange&&(b.getAttribute('aria-label')==='Remove from Needs you'||b.textContent.startsWith('Remove from Needs you'))){const change=window.__staleChange;delete window.__staleChange;b.addEventListener('click',()=>{window.T.state.liveSessions=window.T.state.liveSessions.map(row=>row.session_id==='retained-agent-id'?{...row,[change.field]:change.value}:row);window.__retained=window.T.state.liveSessions.find(row=>row.session_id==='retained-agent-id');},{capture:true,once:true});}const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,height:r.height,hit:b.contains(document.elementFromPoint(x,y))};})()`);
    assert.equal(point.hit,true,'action is hit-testable');if(width===390)assert.ok(point.height>=44,'phone action has 44px target');
    if(keyboard){await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
    else if(width===390){await client.Input.dispatchTouchEvent({type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1}]});await client.Input.dispatchTouchEvent({type:'touchEnd',touchPoints:[]});}
    else{await client.Input.dispatchMouseEvent({type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});}
   };
   const remove=async(keyboard=false)=>{
    let button;
    if(width===1280){await waitFor(`!!document.querySelector('.inbox-remove-wait')`,'desktop Remove action');button=`document.querySelector('.inbox-remove-wait')`;}
    else{await activate(`document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"] [aria-label*="More"]')`);await waitFor(`document.querySelector('[role=menuitem][aria-label="Remove from Needs you"]')?.getClientRects().length>0`,'phone Remove menu item');button=`document.querySelector('[role=menuitem][aria-label="Remove from Needs you"]')`;}
    const help=await ev(`(()=>{const e=${width===1280?"document.querySelector('.inbox-remove-wait-help')":"document.querySelector('[role=menuitem][aria-label=\"Remove from Needs you\"] .menu-item-state')"};if(!e)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{text:e.textContent,visible:r.width>0&&r.height>0&&c.visibility!=='hidden'&&c.display!=='none',inside:r.left>=0&&r.right<=innerWidth+1};})()`);
    assert.ok(help&&help.visible&&help.inside,'visible Remove explanation before activation: '+JSON.stringify(help));
    assert.equal(help.text,'Hides this request from Needs you. Nothing is sent to the agent.');
    await activate(button,keyboard);
   };
   await inbox(); assert.equal(await count(),2,'both requests count before removal');
   for(const field of ['waiting_since','waiting_kind']){
    const old=await ev(`window.__retained[${JSON.stringify(field)}]`);
    await ev(`window.__staleChange={field:${JSON.stringify(field)},value:${JSON.stringify(field==='waiting_since'?'2026-11-07T03:00:00Z':'question')}};true`);
    await remove();
    await waitFor(`document.body.textContent.includes('This request has changed. Check the current request.')`,'stale row explains current request changed');
    assert.equal(await ev('window.__removeCalls.length'),0,field+': stale captured row sends no removal');
    await ev(`window.__retained[${JSON.stringify(field)}]=${JSON.stringify(old)};true`);
   }
   for(const status of [403,409]){await ev(`window.__removeStatus=${status};true`);await remove(status===409);await waitFor(`window.__removeCalls.length===${status===403?1:2}`,'refused removal sent');await waitFor(`document.body.textContent.includes('${status===403?'Only the owner may remove it':'Dismiss it first'}')`,'server refusal wording');assert.equal(await count(),2,'refusal retains count');assert.equal(await ev(`!!document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"]')`),true,'refusal retains row');}
   await ev(`window.__removeStatus=200;true`);await remove();
   await waitFor(`!document.querySelector('#group-table-view tr[data-key="local:retained-agent-id"]')`,'successful removal drops only local request');
   assert.equal(await count(),1,'removed request leaves Inbox count; remote request remains');
   assert.deepEqual(await ev(`import((window.__coralStatic||'/static/')+'dismiss_wait.js').then(m=>[m.canRemoveWait({...window.__retained,waiting_since:''}),m.canRemoveWait({...window.__retained,wait_ignored:false}),m.canRemoveWait({...window.__retained,wait_removed:true}),m.canRemoveWait({...window.__retained,server:'box-2'})])`),[false,false,false,false],'no Remove for unbounded, undismissed, already removed or remote-owner-unknown requests');
   assert.deepEqual((await ev('window.__removeCalls')).at(-1),{session_id:'retained-agent-id',agent_type:'claude',remove:true},'exact removal contract');
   await ev(`window.openTeamPage(${JSON.stringify(team)})`);
   await waitFor(`document.querySelector('#team-page-status')?.textContent.trim()==='All well'`,'team count agrees that local request was removed');
   await ev(`window.__retained=window.T.state.liveSessions.find(s=>s.session_id==='retained-agent-id');window.__retained.wait_removed=false;window.__retained.wait_ignored=false;window.__retained.waiting_since='2026-11-07T02:00:00Z';window.T.render.renderLiveSessions(window.T.state.liveSessions);true`);
   await inbox();assert.equal(await count(),2,'a new request is counted again');
   assert.equal(await ev(`!!document.querySelector('.inbox-remove-wait')`),false,'new undismissed request has no Remove button');
   assert.equal(await ev(`import((window.__coralStatic||'/static/')+'inbox_answer.js').then(m=>m.rowActions(window.__retained).some(a=>a.label==='Remove from Needs you'))`),false,'undismissed phone row has no Remove menu item');
   assert.deepEqual(await ev(`window.__waitWrites.filter(p=>['send','keys','input','answer-prompt'].includes(p.split('/').pop()))`),[],'removal sends no answer');
  }
  console.log('PASS explicit wait removal, refused writes, shared counts and next request at desktop/phone');
 } finally { await removeBoards(ev,teams).catch(()=>{});await client.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
