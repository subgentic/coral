// ST2a: four navigation groups, whole-section moves, old section links and phone summaries.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const failures=[];
 const shot=async name=>{if(!process.env.CORAL_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{const real=window.fetch;window.fetch=(u,o)=>new URL(String(u),location.origin).pathname==='/api/cloud/status'?Promise.resolve(new Response(JSON.stringify({configured:false,hub_relaunch_updates:false,hub_relaunch_available:true}),{status:200,headers:{'Content-Type':'application/json'}})):new URL(String(u),location.origin).pathname==='/api/system/update'?Promise.resolve(new Response(JSON.stringify({enabled:true,relaunch_available:true,installed:'2.0.66',state:'none',auto:true,not_ready_reason:'up_to_date',relaunch:{available:false,reason:'nothing_staged'}}),{status:200,headers:{'Content-Type':'application/json'}})):real(u,o);})()`});
  for(const width of [1440,390])for(const theme of ['dark','light'])for(const size of [16,32]){
   await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`window.showSettingsModal()`);await waitFor(`document.getElementById('settings-modal')?.style.display==='flex'`,'Settings open');
   await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${size}px';true`);await ev(framesJs(2));
   if((width===1440&&theme==='dark'&&size===16)||(width===390&&theme==='light'&&size===32)||(width===390&&theme==='dark'&&size===16)||(width===1440&&theme==='light'&&size===32))await shot(`settings-groups-${width}-${size}-${theme}`);
   const nav=await ev(`({groups:[...document.querySelectorAll('#settings-tabs .settings-nav-label')].map(e=>e.textContent),tabs:[...document.querySelectorAll('#settings-tabs [role=tab]')].map(e=>({id:e.id,name:e.querySelector('.settings-tab-name').textContent,hint:e.querySelector('.settings-tab-name').dataset.sub}))})`);
   if(JSON.stringify(nav.groups)!==JSON.stringify(['You','Agents','This computer','Access'])||nav.tabs.length!==10){failures.push({width,theme,size,nav});continue;}
   assert.equal(await ev(`document.getElementById('settings-tabs').getAttribute('aria-label')`),'Settings sections');
   assert.deepEqual(nav.tabs.map(t=>t.name),['Appearance','Notifications','Terminal','Defaults','Teams and Chief','Updates','Storage and backup','Files and Git','Security and privacy','Coral Hub and remote access']);
   assert.ok(nav.tabs.every(t=>t.hint),'every phone section has a summary');
   if(width===390){
    const styles=await ev(`[...document.querySelectorAll('#settings-tabs .settings-tab-name')].map(e=>({display:getComputedStyle(e,'::after').display,content:getComputedStyle(e,'::after').content,color:getComputedStyle(e,'::after').color,hintSize:parseFloat(getComputedStyle(e,'::after').fontSize),labelSize:parseFloat(getComputedStyle(e).fontSize)}))`);
    assert.ok(styles.every(s=>s.content!=='none'&&s.content!=='normal'&&s.display!=='none'&&s.hintSize<s.labelSize),'phone summaries use smaller secondary text');
    if(theme==='light'&&size===32){await ev(`document.querySelector('#settings-modal .settings-nav').scrollTop=99999;${framesJs(2)}`);await shot('settings-groups-390-32-light-bottom');}
   }
   for(const key of ['general','agents','terminal','notifications','needs-you','files','cleanup','network','chief','security','updates']){
    await ev(`window.showSettingsModal('${key}')`);
    const current=await ev(`[...document.querySelectorAll('#settings-modal .settings-pane')].filter(p=>!p.hidden).map(p=>p.dataset.group)`);
    assert.deepEqual(current,[key==='needs-you'?'notifications':key],`legacy section ${key} resolves`);
   }
   await waitFor(`!!document.querySelector('#update-pane-body .settings-section-link')`,'Updates link to remote access');
   await ev(`document.querySelector('#update-pane-body .settings-section-link').scrollIntoView({block:'center'});${framesJs(2)}`);
   const fit=await ev(`(() => {const b=document.querySelector('#update-pane-body .settings-section-link'),r=b.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth;})()`);
   assert.ok(fit,'renamed Updates link fits at enlarged text');
   if((width===1440&&theme==='dark'&&size===16)||(width===390&&theme==='light'&&size===32))await shot(`settings-updates-link-${width}-${size}-${theme}`);
   await ev(`document.querySelector('#update-pane-body .settings-section-link').click();true`);
   await waitFor(`document.getElementById('settings-pane-network').hidden===false`,'Updates opens renamed remote access section');
   const inbox=await ev(`({inside:!!document.getElementById('settings-inbox-rows').closest('#settings-pane-notifications'),heading:document.getElementById('settings-inbox-block-title')?.textContent,controls:document.querySelectorAll('#settings-inbox-done').length})`);
   assert.deepEqual(inbox,{inside:true,heading:'What reaches Needs you',controls:1});
   await ev(`window.showSettingsModal('general')`);await ev(framesJs(2));
   await ev(`document.getElementById('settings-modal').dataset.screen='sections';document.getElementById('settings-tab-general').focus();true`);
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'ArrowDown',code:'ArrowDown'});await client.Input.dispatchKeyEvent({type:'keyUp',key:'ArrowDown',code:'ArrowDown'});
   assert.equal(await ev(`document.getElementById('settings-tab-notifications').getAttribute('aria-selected')`),'true','arrow navigation skips group labels');
  }
  assert.deepEqual(failures,[],'four groups and ten sections');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
