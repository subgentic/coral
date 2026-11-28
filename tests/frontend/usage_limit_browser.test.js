// #20700: the same limited agents across desktop, phone, chat and Settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const fixed=new Date();fixed.setHours(20,55,0,0);const resetDate=new Date(fixed);resetDate.setHours(22,7,0,0);const reset=resetDate.toISOString();const tomorrow=new Date(fixed);tomorrow.setDate(tomorrow.getDate()+1);tomorrow.setHours(9,0,0,0);
 const row = (id,name,type,blocked,extra={}) => ({session_id:id,name,display_name:name,agent_type:type,working_directory:'/work/project',working:false,sleeping:false,done:false,awaiting_user:false,board_project:'',...extra,...(blocked?{blocked}: {})});
 const rows=[row('working','Lead Developer','claude',null,{working:true}),row('ready','QA Reviewer','claude',null,{awaiting_user:true,done:true}),row('codex','Backend Dev','codex',{kind:'usage_limit',vendor:'codex',reset_at:reset}),row('codex2','Backend Dev 2','codex',{kind:'usage_limit',vendor:'codex',reset_at:reset}),row('security','Security Reviewer','codex',{kind:'usage_limit',vendor:'codex',reset_at:reset}),row('claude','Docs','claude',{kind:'usage_limit',vendor:'claude',reset_at:tomorrow.toISOString()}),row('agy','Researcher','agy',{kind:'usage_limit',vendor:'agy',reset_at:null}),row('ended','Ended at limit','claude',null,{sleeping:true,sleep_reason:'agent_exited'})];
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for (const [width,mobile,root] of [[1280,false,'#live-sessions-list'],[390,true,'#mobile-session-list']]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile});
   await Page.navigate({url:process.env.CORAL_TEST_URL+'/'});await Page.loadEventFired();await install();
   await waitFor(`document.querySelectorAll('${root} .empty-launch').length===3`,'the empty list still shows all three launch cards');
   await ev(`(()=>{const start=performance.now();Date.now=()=>${fixed.getTime()}+performance.now()-start;})();T.state.liveSessions=${JSON.stringify(rows)};T.render.renderLiveSessions(T.state.liveSessions);true`);
   await waitFor(`!!document.querySelector('${root} [data-session-id="codex"]')`,'limited row rendered');
   for(const theme of ['light','dark']) {
    await ev(`import((window.__coralStatic||'/static/')+'settings_core.js').then(m=>m.applyTheme('${theme}'))`);
    await ev(framesJs(3));
    if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/agents-${width}-${theme}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   }
   if(process.env.CORAL_USAGE_PROBE){await ev(`document.documentElement.style.fontSize='200%';true`);await ev(framesJs(3));if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/agents-${width}-200.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));await ev(`document.documentElement.style.fontSize='';true`);continue;}
   assert.equal(await ev(`document.querySelector('${root} [data-session-id="codex"]').dataset.state`),'usage_limit');
   assert.match(await ev(`document.querySelector('${root} .usage-limit-summary').textContent`),/Codex agent.*reset/);
   assert.equal(await ev(`document.querySelector('${root} [data-session-id="codex"] .usage-limit-vendor').textContent`),'Codex','the limited row names its vendor as in the mock');
   assert.match(await ev(`document.querySelector('${root} .usage-limit-heading').textContent`),/Waiting for a usage limit to reset/);
   assert.match(await ev(`document.querySelector('${root} [data-session-id="agy"]').textContent`),/time unknown/);
   const mockStyle=await ev(`(() => {const box=document.querySelector('${root} .usage-limit-summary'),h=document.querySelector('${root} .usage-limit-heading');return {bold:[...box.querySelectorAll('strong')].map(e=>e.textContent),mark:box.querySelector('.usage-limit-mark').textContent,help:box.querySelector('small').textContent,header:[...h.children].find(e=>e.getBoundingClientRect().height).textContent,upper:getComputedStyle(h).textTransform,band:getComputedStyle(h).backgroundColor,summary:[...box.querySelectorAll('p')].filter(e=>e.getBoundingClientRect().height).map(e=>e.textContent)};})()`);
   assert.ok(mockStyle.bold.includes('3 Codex agents')&&mockStyle.bold.includes('22:07')&&mockStyle.bold.includes('09:00 tomorrow'),'mock counts, vendors and clocks are emphasized');
   assert.equal(mockStyle.mark,'!');
   assert.equal(mockStyle.help,'Coral sends nothing to them until then. Other agents carry on.');
   assert.equal(mockStyle.header,mobile?'Usage limit · 5':'Waiting for a usage limit to reset · 5');
   assert.equal(mockStyle.upper,'uppercase');assert.notEqual(mockStyle.band,'rgba(0, 0, 0, 0)');
   if(mobile)assert.deepEqual(mockStyle.summary,['3 Codex agents reset 22:07','1 Claude agent resets 09:00 tomorrow','1 Antigravity agent: reset time unknown']);


   if(mobile)assert.ok(await ev(`(()=>{const r=document.querySelector('${root} [data-session-id="codex"]'),b=r.getBoundingClientRect(),d=r.querySelector('.session-dot').getBoundingClientRect();return d.width>0&&d.left>=b.left&&d.right<=b.right&&d.top>=b.top&&d.bottom<=b.bottom;})()`),'the row keeps its state mark inside it on a phone (#22105: the phone row is the sidebar\'s, no avatar)');
   const layout = await ev(`(() => {const r=document.querySelector('${root} [data-session-id="agy"]');const n=r.querySelector('.session-name-row').getBoundingClientRect(), d=r.querySelector('.usage-limit-detail').getBoundingClientRect(); return {clear:d.height===0||d.top>=n.bottom-1,lines:[...document.querySelectorAll('${root} .usage-limit-summary p')].filter(p=>p.getBoundingClientRect().height).map(p=>p.getBoundingClientRect().top)};})()`);
   if(mobile)assert.match(await ev(`document.querySelector('${root} [data-session-id="codex"] .session-status-line').textContent`),/^Limit · resets /,'phone uses the mock’s single compact limit line');
   assert.equal(layout.clear,true,'unknown-time pill never overlaps its detail');
   assert.ok(layout.lines.every((v,i,a)=>!i||v>a[i-1]),'one summary line per vendor');
   await ev(`document.documentElement.style.fontSize='200%';true`);await ev(framesJs(3));
   assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth+1`),'200% text stays inside the viewport');
   if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/agents-${width}-200.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   await ev(`document.documentElement.style.fontSize='';true`);
   if(mobile&&process.env.CORAL_SCREENSHOT_DIR){await ev(`document.querySelector('${root} [data-session-id="agy"]').scrollIntoView({block:'center'});true`);await ev(framesJs(3));fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/agents-390-bottom.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   await ev(`T.state.liveSessions=T.state.liveSessions.map(s=>s.session_id==='agy'?{...s,blocked:{kind:'usage_limit',vendor:'agy',reset_at:${JSON.stringify(reset)}}}:s);T.render.renderLiveSessions(T.state.liveSessions);true`);
   assert.doesNotMatch(await ev(`document.querySelector('${root} [data-session-id="agy"]').textContent`),/time unknown/,'agy duration-derived clock is shown when the row carries it');
   await ev(`T.state.liveSessions=T.state.liveSessions.map(s=>s.session_id==='codex'?{...s,blocked:null,working:true}:s);T.render.renderLiveSessions(T.state.liveSessions);true`);
   assert.equal(await ev(`document.querySelector('${root} [data-session-id="codex"]').dataset.state`),'working','a resumed agent leaves the limit section');
   await ev(`T.state.liveSessions=T.state.liveSessions.map(s=>({...s,blocked:null}));T.render.renderLiveSessions(T.state.liveSessions);true`);
   assert.equal(await ev(`!!document.querySelector('${root} .usage-limit-summary')`),false,'no limits means no summary');
   await ev(`T.state.liveSessions=[{session_id:'boundary',name:'Boundary',agent_type:'claude',sleeping:false,blocked:{kind:'usage_limit',vendor:'claude',reset_at:new Date(Date.now()+150).toISOString()}}];T.render.renderLiveSessions(T.state.liveSessions);true`);
   await waitFor(`document.querySelector('${root} [data-session-id="boundary"]')?.dataset.state==='idle'`,'the known reset leaves by itself on a quiet feed');
   await ev(`window.showSettingsModal('agents')`);
   await waitFor(`!!document.getElementById('settings-auto-resume-limit')`,'limit reset setting');
   assert.equal(await ev(`document.getElementById('settings-auto-resume-limit').checked`),false,'auto resume is off by default');
   await ev(`document.getElementById('settings-auto-resume-limit').closest('.sv-row').scrollIntoView({block:'center',behavior:'instant'});true`);
   await ev(framesJs(3));
   if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/settings-default-${width}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   await ev(`document.getElementById('settings-auto-resume-limit').checked=true;true`);
   assert.equal(await ev(`import((window.__coralStatic||'/static/')+'settings_form.js').then(m=>m.readSettingsForm(true).payload.auto_resume_at_limit_reset)`),true,'opt-in saves the exact server setting');
   await ev(`document.getElementById('settings-auto-resume-limit').closest('.sv-row').scrollIntoView({block:'center',behavior:'instant'});true`);
   await ev(framesJs(3));
   if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/settings-${width}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   await ev(`window.hideSettingsModal();true`);
   const chat=await ev(`import((window.__coralStatic||'/static/')+'usage_limit.js').then(m=>m.usageLimitChat(${JSON.stringify(rows.find(s=>s.session_id==='codex'))},'limit'))`);
   assert.match(chat,/Usage limit.*resets at/);
   await ev(`(() => {window.__m.add('Limit chat','limit message ',1,{sleeping:false,agent_type:'codex',session_id:'limit-chat'});const entry=window.__m.entry.bind(window.__m);window.__m.entry=a=>({...entry(a),...(a.session_id==='limit-chat'?{blocked:{kind:'usage_limit',vendor:'codex',reset_at:${JSON.stringify(reset)}},limit_resume_at:${JSON.stringify(reset)}}:{})});T.state.liveSessions=Object.values(window.__m.agents).map(a=>window.__m.entry(a));const original=window.fetch.bind(window);window.fetch=async(u,o)=>{const r=await original(u,o);if(String(u).includes('/chat')){const d=await r.json();return new Response(JSON.stringify({...d,limit_notice:'Usage limit.'}),{status:r.status});}return r;};return true;})()`);
   await ev(`window.selectLiveSession('Limit chat','codex','limit-chat','local')`);
   await waitFor(`!!document.querySelector('.chat-usage-limit-notice')`,'the real chat paints the limit note');
   assert.match(await ev(`document.querySelector('.chat-usage-limit-notice').textContent`),/22:07/,'chat carries the same reset clock');
   assert.match(await ev(`document.querySelector('.chat-usage-limit-notice').textContent`),/try to resume/,'only the scheduled row promises a resume attempt');
   assert.ok(await ev(`document.querySelector('.chat-usage-limit-notice').textContent.includes('Coral won’t send it anything until then.')`),'chat preserves the approved no-send sentence');
   if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/chat-${width}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
   await ev(`window.__feed('limit-chat',{sleeping:true,sleep_reason:'agent_exited'});true`);
   await waitFor(`T.state.liveSessions.find(s=>s.session_id==='limit-chat')?.sleeping===true`,'the live update marks the exited agent asleep');
   await ev(`window.selectLiveSession('Limit chat','codex','limit-chat','local')`);
   await waitFor(`document.querySelector('.chat-usage-limit-notice')?.textContent.includes('asleep')`,'an exited CLI stays asleep at a limit');
   assert.match(await ev(`document.querySelector('.chat-usage-limit-notice').textContent`),/not be resumed automatically/);
   await waitFor(`!document.querySelector('${root} .usage-limit-summary')`,'an exited CLI leaves the waiting summary after the live update');
   if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/chat-ended-${width}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));

   assert.match(await ev(`import((window.__coralStatic||'/static/')+'usage_limit.js').then(m=>m.usageLimitChat({sleeping:true,sleep_reason:'agent_exited'},'usage limit'))`),/asleep.*not be resumed/);

  }
  if(process.env.CORAL_MOCK_HTML && process.env.CORAL_SCREENSHOT_DIR){
   await Emulation.setDeviceMetricsOverride({width:1280,height:1500,deviceScaleFactor:1,mobile:false});
   await Page.navigate({url:'data:text/html;base64,'+fs.readFileSync(process.env.CORAL_MOCK_HTML).toString('base64')});await Page.loadEventFired();
   for(const theme of ['light','dark']){await ev(`document.getElementById('th-${theme}').checked=true;document.querySelectorAll('h2')[1].scrollIntoView();true`);await ev(framesJs(3));fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+`/mock-${theme}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
  }
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
