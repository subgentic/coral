// #16984: a review row approves through its own action; opening the viewer is an explicit choice.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, nextFrame } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const team = 'row-decision-' + Date.now().toString(36), S = `(window.__coralStatic||'/static/')`;
 const press = async selector => {
  await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});true`); await nextFrame(ev);
  const p = await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return {x,y,hit:h===b||b.contains(h)}})()`);
  assert.ok(p.hit, 'the actual pointer target is the action button: ' + selector);
  for (const type of ['mouseMoved','mousePressed','mouseReleased']) await client.Input.dispatchMouseEvent({type,x:p.x,y:p.y,button:type==='mouseMoved'?'none':'left',buttons:type==='mousePressed'?1:0,clickCount:type==='mouseMoved'?0:1});
 };
 const viewer = `!!document.querySelector('#artifact-viewer-title')?.getClientRects().length`;
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for (const [width,height,mobile] of [[1440,900,false],[390,844,true]]) {
   await Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile});await Emulation.setTouchEmulationEnabled({enabled:mobile});
   await Page.navigate({url:BASE+'/agents'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer'})}).then(r=>r.ok)`);
   await ev(`(()=>{const real=window.fetch,json=x=>Promise.resolve(new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}})),hex=n=>n.toString(16).padStart(64,'0');
    window.__rowDecision={calls:[],items:[['README.md','text/markdown',true],['unread.md','text/markdown',false],['preview.html','text/html',false]].map(([name,media_type,read],i)=>({id:hex(i+1),team:'${team}',name,media_type,size:90,created_at:new Date(Date.now()-(i+1)*60000).toISOString(),source:'upload',available:true,produced_by:'Writer',tags:['for review',...(read?['read']:[])]}))};
    window.fetch=(url,opts={})=>{const u=new URL(String(url),location.origin),st=window.__rowDecision;
     if(u.pathname==='/api/team-artifacts')return json(window.__reviewFixturePage(u,location.origin,{'${team}':st.items}));
     const hit=u.pathname.match(/^\\/api\\/board\\/[^/]+\\/artifacts\\/([0-9a-f]{64})\\/review$/);
     if(hit&&opts.method==='POST'){const body=JSON.parse(opts.body),row=st.items.find(a=>a.id===hit[1]);st.calls.push({id:hit[1],body});row.tags=['approved'];return json({changed:true,state:'approved',delivered:true,to:'Writer',review:{state:'approved',at:new Date().toISOString()}})}
     return real(url,opts)};localStorage.removeItem('coral-inbox-needs-filters');return true})()`);
   await ev(`(async()=>{window.switchNavTab('hub-inbox');await(await import(${S}+'inbox_tab.js')).selectInboxTab('needs');return true})()`);
   await waitFor(`!!document.querySelector('#group-table-view button[aria-label="Approve: README.md"]')`,'review row actions');
   await press('#group-table-view button[aria-label="Approve: README.md"]');
   await waitFor(`window.__rowDecision.calls.length===1`,'read README approved with one click');
   assert.equal(await ev(viewer),false,`${width}: README Approve must not open the viewer`);
   assert.equal(await ev(`window.__rowDecision.calls[0].body.decision`),'approve');
   await waitFor(`!document.querySelector('#group-table-view button[aria-label="Approve: README.md"]')`,'approved README row leaves Needs you');
   for (const name of ['unread.md','preview.html']) {
    await press(`#group-table-view button[aria-label="Approve: ${name}"]`);
    await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length>0`,'unopened review asks before approval');
    assert.equal(await ev(`document.getElementById('confirm-modal-title').textContent`),'Approve without opening?');
    assert.equal(await ev(viewer),false,`${width}: ${name} does not silently open a viewer`);
    await press('#confirm-modal-yes');
    await waitFor(`!document.querySelector('#group-table-view button[aria-label="Approve: ${name}"]')`,'confirmed approval clears the row');
   }
   const calls=await ev(`window.__rowDecision.calls`);assert.equal(calls.length,3,`${width}: exactly one decision per row`);assert.ok(calls.every(c=>c.body.decision==='approve'));
   assert.equal(await ev(viewer),false,`${width}: approvals do not require a viewer click`);
  }
  console.log('PASS README/Markdown/HTML row approval: one decision each, unopened-file confirmation, no viewer detour at 1440 and 390 px');
 } finally { await removeBoards(ev,[team]).catch(()=>{});await client.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
