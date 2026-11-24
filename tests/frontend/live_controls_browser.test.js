// #21030: the local-only Live controls cannot enable stale/unread views; Stop wins
// an in-flight preview. All transport is fake and uses the reviewed local shapes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 try {
  const LIVE_PRELOAD = `(() => {
   const real=fetch, reply=(x,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}}));
   window.__liveCalls=[];window.__liveClosed=false;window.__created=false;window.__holdPreview=false;window.__badHash=false;
   window.__link={id:'one',team:'test-team',hub:'00000000-0000-4000-8000-000000000001',state:'draft',agents:[{key:'agent-one',role:'Frontend Dev',status:'working',chat:false},{key:'agent-two',role:'QA Engineer',status:'idle',chat:false}],draft:{chat_key:'',period_days:90,expires_in:'none',delay_s:30},created_by:'you',expires_in:'none',delay_s:30,period_days:90};
   const publicAt=Math.floor(Date.now()/1000)-45;
   window.__frame={v:1,seq:1,agents:[{role:'Frontend Dev',status:'working',task:'Build the public preview',chat:[{from:'Person',text:'<img src=x onerror="window.__pwn=1">',at:publicAt},{w:true,text:'NEVER SHOW THIS'}]}],posts:[{from:'QA Engineer',text:'<img src=x onerror=window.__pwn=1>',at:publicAt},{w:true,text:'NEVER SHOW THIS'},{from:'QA Engineer',text:'The layout is ready.',at:publicAt}]};
   window.fetch=(u,o={})=>{const p=new URL(String(u),location.origin).pathname;if(p==='/api/cloud/links')return reply({links:[{link_id:'lnk-11111111',label:'My Hub',state:'active'},{link_id:'lnk-22222222',label:'Second Hub',state:'active'},{link_id:'lnk-33333333',label:'Paused Hub',state:'paused'}]});if(!p.startsWith('/api/live/'))return real(u,o);
    const method=o.method||'GET',body=o.body?JSON.parse(o.body):null;window.__liveCalls.push({p,method,body});
    if(window.__liveClosed)return reply({error:'live_closed'},404);
    if(p==='/api/live/links'&&method==='GET')return reply({links:window.__created?[window.__link]:[]});
    if(p==='/api/live/links'&&method==='POST'){window.__created=true;return reply(window.__link);}
    if(p.endsWith('/views')){window.__link={...window.__link,draft:body,agents:window.__link.agents.map(a=>({...a,draft_chat:a.key===body.chat_key}))};return reply(window.__link)}
    if(p.endsWith('/preview')){const frame={...window.__frame,agents:window.__link.agents.map(a=>({role:a.role,status:a.status,task:a.key==='agent-one'?'Build the public preview':'Review the phone layout',...(a.key===window.__link.draft.chat_key?{chat:window.__frame.agents[0].chat}:{})}))};const value={hash:'current-hash',frame};return window.__holdPreview?new Promise(resolve=>window.__releasePreview=()=>resolve(new Response(JSON.stringify(value)))):reply(value)}
    if(p.endsWith('/go-live')||p.endsWith('/resume')||p.endsWith('/reconfirm')){if(window.__badHash)return reply({error:'bad_hash'},409);window.__link={...window.__link,...window.__link.draft,agents:window.__link.agents.map(a=>({...a,in_view:true,chat:a.key===window.__link.draft.chat_key})),state:'live',live_since:new Date().toISOString(),notice_at:new Date(Date.now()-3600000).toISOString(),reconfirm_due:new Date(Date.now()+24*3600000).toISOString(),pause_at:new Date(Date.now()+48*3600000).toISOString()};return reply(window.__link)}
    if(p.endsWith('/pause')||p.endsWith('/stop')){window.__link={...window.__link,state:p.endsWith('/stop')?'stopped':'paused'};return reply(window.__link)}
    throw Error('unexpected live route '+p);
   };return true;
  })()`;
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD+'\n'+LIVE_PRELOAD});
  await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
  const S=`(window.__coralStatic||'/static/')`;
  await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.hub=false;window.__liveModule=await import(${S}+'live_controller.js');return true})()`);
  assert.deepEqual(await ev(`window.__liveModule.localLiveLinks('test-team')`),[]);
  await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.hub=true;window.__beforeRemote=window.__liveCalls.length;return true})()`);
  assert.equal(await ev(`window.__liveModule.localLiveLinks('@remote/test-team')`),null);
  assert.equal(await ev(`window.__liveCalls.length===window.__beforeRemote`),true,'remote team refuses before any fetch');
  await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.hub=false;const host=document.createElement('div');host.id='live-proof';document.body.replaceChildren(host);window.__liveUI=window.__liveModule.mountLiveControls(host,{team:'test-team',teamLabel:'test-team',links:[]});return true})()`);
  await ev(`const probe=document.createElement('div');probe.id='live-time-proof';document.body.append(probe);window.__timeUI=window.__liveModule.mountLiveControls(probe,{team:'test-team',teamLabel:'test-team',links:[{...window.__link,state:'live',live_since:'2026-11-01T09:00:00Z',notice_at:'2026-11-01T10:00:00Z',reconfirm_due:'2026-12-01T09:00:00Z',pause_at:'2026-12-02T09:00:00Z'}]});true`);
  assert.equal(await ev(`document.querySelector('#live-time-proof [data-live="needs-title"]').textContent`),'Re-confirm your live link','real RFC3339 route timestamps trigger the re-confirm notice');
  assert.equal(await ev(`document.querySelector('#live-time-proof [data-live="needs-facts"]').textContent.includes(new Date('2026-11-01T09:00:00Z').toLocaleString())`),true,'real live_since is displayed');
  await ev(`window.__timeUI.destroy();document.querySelector('#live-time-proof').remove();true`);
  const q=name=>`document.querySelector('[data-live="${name}"]')`;
  const click=expr=>ev(`${expr}.click();true`);
  assert.deepEqual(await ev(`Array.from(${q('delay')}.options,o=>o.value)`),['30','60'],'only delays accepted by slice 6 are offered');
  assert.deepEqual(await ev(`Array.from(${q('expiry')}.options,o=>o.value)`),['1','7','30','90'],'renewal is bounded, with no never choice');
  assert.equal(await ev(`${q('expiry')}.value`),'90','roster defaults to the maximum renewal period');

  const settled=()=>waitFor(`!${q('load-preview')}.disabled`, 'Live request settled',8000);
  await ev(`const hub=document.querySelector('[aria-label="Hub link id"]');hub.value='00000000-0000-4000-8000-000000000001';hub.dispatchEvent(new Event('input'));true`);
  await waitFor(`document.querySelector('[aria-label="Share through"]').options.length===3`,'only active Hub choices');
  assert.equal(await ev(`${q('actions')}.querySelector('button').disabled`),true,'two Hubs require an explicit pick');
  await ev(`const via=document.querySelector('[aria-label="Share through"]');via.value='lnk-22222222';via.dispatchEvent(new Event('change'));true`);
  await click(`${q('actions')}.querySelector('button')`);await settled();
  assert.equal(await ev(`${q('actions')}.querySelector('button').disabled`),true,'unread preview cannot go live');
  assert.equal(await ev(`window.__liveCalls.find(c=>c.p==='/api/live/links'&&c.method==='POST').body.via`),'lnk-22222222','create routes through the chosen active Hub');
  await ev(`${q('expiry')}.value='30';${q('expiry')}.dispatchEvent(new Event('change'));true`);await settled();
  assert.equal(await ev(`window.__liveCalls.findLast(c=>c.p.endsWith('/views')).body.period_days`),30,'roster renewal is set at the computer');
  await click(q('load-preview'));await settled();
  assert.equal(await ev(`${q('public')}.querySelector('img')===null && !window.__pwn`),true,'public text cannot become HTML');
  assert.equal(await ev(`${q('public')}.textContent.includes('NEVER SHOW THIS')`),false,'withheld content is ignored');
  await click(q('confirm'));
  assert.equal(await ev(`${q('actions')}.querySelector('button').disabled`),false);
  await click(`document.querySelector('[data-agent-key="agent-one"]')`);await settled();
  assert.equal(await ev(`${q('confirm-wrap')}.hidden`),true,'view edit invalidates the preview');
  assert.equal(await ev(`window.__liveCalls.findLast(c=>c.p.endsWith('/views')).body.chat_key`),'agent-one','writes stable key, not public role');
  assert.equal(await ev(`window.__liveCalls.findLast(c=>c.p.endsWith('/views')).body.period_days`),7,'chat renewal is fixed at seven days');
  assert.equal(await ev(`${q('expiry')}.value`),'7');
  assert.equal(await ev(`${q('expiry')}.disabled`),true,'chat cannot choose a longer renewal period');
  await click(`document.querySelector('[data-agent-key="agent-two"]')`);await settled();
  assert.equal(await ev(`document.querySelectorAll('[data-agent-key]:checked').length`),1);
  await click(q('load-preview'));await settled();await click(q('confirm'));
  await ev(`window.__badHash=true;true`);await click(`${q('actions')}.querySelector('button')`);await settled();
  assert.equal(await ev(`${q('confirm-wrap')}.hidden`),true,'409 voids the stale hash');
  await ev(`window.__badHash=false;true`);await click(`document.querySelector('[data-agent-key="agent-one"]')`);await settled();await click(q('load-preview'));await settled();await click(q('confirm'));await click(`${q('actions')}.querySelector('button')`);await settled();
  assert.deepEqual(await ev(`window.__liveCalls.findLast(c=>c.p.endsWith('/go-live')).body`),{hash:'current-hash',read:true});
  assert.equal(await ev(`${q('needs')}.hidden`),false,'live notice cannot be dismissed');
  assert.equal(await ev(`${q('needs-title')}.textContent`),'Re-confirm your live link','RFC3339 notice_at drives the due notice');
  assert.equal(await ev(`${q('needs-facts')}.textContent.includes('Invalid Date')`),false);
  const renewal = 'Re-confirm due in 24 hours. One confirmation renews roles, status, task titles, posts and Frontend Dev’s chat together.';
  assert.equal(await ev(`${q('needs-copy')}.textContent`),renewal);
  assert.equal(await ev(`${q('state')}.textContent`),'Live · re-confirm soon');
  assert.equal(await ev(`${q('renew')}.textContent`),'Notice: re-confirm this link in 24 hours. Its seven-day period covers everything it shows. After the due time there is 24 hours of grace, then the entire link pauses.');
  assert.equal(await ev(`${q('confirm-text')}.textContent`),"I read the preview. Frontend Dev's chat includes my typed messages and the agent's replies, shown 30 seconds late. Anyone with the link can read it. This confirms everything the link shows.");
  assert.equal(await ev(`${q('status-line')}.textContent`),'');
  assert.equal(await ev(`${q('needs-facts')}.textContent.includes('viewers')`),false);
  assert.equal(await ev(`${q('link')}.textContent`),'The link is on the Hub page.');
  await click(`${q('actions')}.querySelectorAll('button')[1]`);await settled();
  assert.equal(await ev(`${q('state')}.textContent`),'paused');
  assert.equal(await ev(`${q('public')}.textContent.includes('paused')`),true);
  await click(q('load-preview'));await settled();await click(q('confirm'));await click(`${q('actions')}.querySelector('button')`);await settled();
  assert.deepEqual(await ev(`window.__liveCalls.findLast(c=>c.p.endsWith('/resume')).body`),{hash:'current-hash'});
  await click(q('load-preview'));await settled();await click(q('confirm'));await click(`${q('actions')}.querySelector('button')`);await settled();
  assert.deepEqual(await ev(`window.__liveCalls.findLast(c=>c.p.endsWith('/reconfirm')).body`),{},'re-confirm is a human click with no view widening');
  const shots=process.env.CORAL_SCREENSHOT_DIR;
  for(const width of [1440,390])for(const light of [false,true]){
   await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width===390});
   await ev(`document.documentElement.dataset.theme=${JSON.stringify(light?'light':'dark')};true`);
   assert.equal(await ev('document.documentElement.scrollWidth>innerWidth'),false,'layout fits '+width);
   if(shots){fs.mkdirSync(shots,{recursive:true});fs.writeFileSync(shots+'/live-controls-'+width+'-'+(light?'light':'dark')+'.png',Buffer.from((await Page.captureScreenshot({captureBeyondViewport:true})).data,'base64'))}
  }
  await ev(`(async()=>{window.__liveNeeds=await import(${S}+'live_needs.js');const host=document.createElement('div');host.id='live-inbox';document.body.append(host);window.__liveNeeds.mountLiveAttention(host);await window.__liveNeeds.refreshLiveAttention();return true})()`);
  assert.equal(await ev(`document.querySelector('#live-inbox').textContent.includes('Re-confirm your live link')`),true,'persistent Inbox card derives from the link list');
  assert.equal(await ev(`document.querySelector('#live-inbox').textContent.includes('Dismiss')`),false);
  assert.equal(await ev(`window.__liveNeeds.liveAttentionCount()`),1);
  await click(`document.querySelector('[data-agent-key="agent-two"]')`);await settled();
  assert.equal(await ev(`document.querySelector('#live-inbox').textContent.includes('posts and Frontend Dev’s chat together.')`),true,'draft edit cannot misstate the approved live chat');
  await ev(`window.__liveUI.destroy();window.__liveUI=window.__liveModule.mountLiveControls(document.querySelector('#live-proof'),{team:'test-team',teamLabel:'test-team',links:[window.__link]});true`);
  assert.equal(await ev(`document.querySelector('[data-agent-key="agent-two"]').checked`),true,'reload edits the saved draft');
  assert.equal(await ev(`${q('needs-copy')}.textContent`),renewal,'reload keeps the approved live display');
  assert.equal(await ev(`${q('actions')}.querySelector('button').textContent`),'Go live','saved draft requires a fresh go-live');
  await ev(`window.__holdPreview=true;true`);await click(q('load-preview'));await waitFor('!!window.__releasePreview','held preview');
  await click(`document.querySelector('[data-stop]')`);await waitFor(`${q('state')}.textContent==='stopped'`,'Stop ends link');
  await ev(`window.__releasePreview();true`);
  await waitFor(`${q('actions')}.textContent==='Create preview link'`,'stopped actions');
  assert.equal(await ev(`${q('confirm-wrap')}.hidden`),true,'late preview cannot restore an enabling action');
  await ev(`window.__link={...window.__link,state:'paused',paused_reason:'not_reconfirmed',notice_at:'1970-01-01T00:00:01Z'};window.__liveNeeds.refreshLiveAttention();true`);
  await waitFor(`document.querySelector('#live-inbox').textContent.includes('whole link is paused')`,'expired link remains actionable');
  assert.equal(await ev('window.__liveNeeds.liveAttentionCount()'),1);
  await ev(`window.__liveClosed=true;window.__beforeClosed=window.__liveCalls.length;true`);
  assert.equal(await ev(`window.__liveModule.localLiveLinks('test-team')`),null);
  assert.equal(await ev(`window.__liveModule.localLiveLinks('test-team')`),null);
  await ev(`window.__liveNeeds.refreshLiveAttention();true`);
  assert.equal(await ev(`window.__liveCalls.length-window.__beforeClosed`),1,'shut gate is fetched once per page session');
  console.log('PASS local Live controls: gate, remote refusal, stable chat keys, preview/read/hash gates, inert text, single chat, Stop race, desktop/phone both themes');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
