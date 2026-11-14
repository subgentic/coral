// ST6: Settings on/off controls, help and Docs links share one pattern.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const Input = client.Input;
 const failures = [];
 const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.addScriptToEvaluateOnNewDocument({source:`(() => { const real = window.fetch; window.fetch = (u,o={}) => { const p = new URL(String(u),location.origin).pathname; const data = p === '/api/cloud/status' ? {configured:true,state:'connected',hub_url:'https://app.coralhub.dev',label:'Fixture Mac',server_id:'fixture',max_mode:'launch',max_mode_saved:true,allow_hub_auto_accept:true,redact_tokens:true,hub_cross_team_settings:true} : p === '/api/dropbox/status' ? {app_key_set:true,connected:true,state:'connected',account_id:'dbid:fixture',backup:{backed_up:4},filters:{types:[],max_age_days:0},retention:{days:0}} : p === '/api/system/auth-status' ? {authenticated:true,password_set:true,method:'session',local:true} : p === '/api/auth/sessions' ? {sessions:[]} : p === '/api/auth/hub-signin' ? {linked:true,enabled:false,owner_known:true} : p === '/api/auth/hub-origins' ? {origins:[]} : null; return data ? Promise.resolve(new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})) : real(u,o); }; })()`});
  for (const width of [1440,390]) for (const theme of ['dark','light']) for (const size of [16,32]) {
   await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
   await ev(`document.documentElement.dataset.theme='${theme}'; document.documentElement.style.fontSize='${size}px'; window.showSettingsModal('cleanup')`); // Storage and cleanup is the pane in view: its Dropbox module loads when it is shown
   await waitFor(`!!document.getElementById('sec-hub-enabled')`,'Hub sign-in switch');
   await waitFor(`!document.getElementById('settings-dropbox-backup').hidden`,'connected Dropbox controls');
   const groups = await ev(`[...document.querySelectorAll('#settings-modal .settings-pane[data-group]')].map(p=>p.dataset.group)`);
   for (const group of groups) {
    await ev(`document.getElementById('settings-tab-${group}')?.click(); true`);
    if (group==='network') await ev(`document.querySelectorAll('#settings-cloud details.settings-cloud-more').forEach(d=>{d.hidden=false;d.open=true}); true`);
    await ev(framesJs(2));
    const helpIssues = await ev(`(() => { const root=document.getElementById('settings-modal'), expected=${size}*0.6875; return [...root.querySelectorAll('.sv-help,.settings-hint,.toggle-desc,.tb-note,.sec-muted')].filter(e=>e.getClientRects().length && !e.closest('[hidden]') && !['status','alert'].includes(e.getAttribute('role'))).filter(e=>!e.classList.contains('sv-help') || Math.abs(parseFloat(getComputedStyle(e).fontSize)-expected)>0.2).map(e=>e.outerHTML.slice(0,200)); })()`);
    if (group==='cleanup') {
     const share = await ev(`(() => { const row=document.getElementById('settings-dropbox-hubshare'), hint=row.querySelector('#settings-dropbox-hubshare-desc'), details=row.querySelector('details'); return {shown:!row.hidden, rule:hint.textContent.trim(), visible:hint.getClientRects().length>0, closed:!details.open, safety:details.textContent}; })()`);
     assert.equal(share.shown,true);
     assert.equal(share.visible,true,'Share-only consent stays visible without opening details');
     assert.equal(share.rule,'Private and secret-looking files are never sent. Only when you press Share.');
     assert.equal(share.closed,true);
     assert.match(share.safety,/private or tagged internal is never sent/);
     assert.match(share.safety,/secret waits here for you to press Upload anyway/);
    }
    if (helpIssues.length) failures.push(`${width}/${size}/${theme}/${group}: help pattern ${JSON.stringify(helpIssues)}`);
    if (['general','cleanup','network','security'].includes(group) && ((width===1440 && size===16 && theme==='dark') || (width===390 && size===32 && theme==='light'))) await shot(`settings-rows-${width}-${size}-${theme}-${group}`);
    if (group==='cleanup' || group==='security') {
     const id=group==='cleanup'?'settings-dropbox-autosync':'sec-hub-enabled';
     await ev(`document.getElementById('${id}').scrollIntoView({block:'center'}); ${framesJs(2)}`);
     const box=await ev(`(() => { const i=document.getElementById('${id}'), r=i.getBoundingClientRect(), p=i.closest('label').getBoundingClientRect(); return {w:r.width,h:r.height,right:Math.abs(r.right-p.right)<2,top:Math.abs(r.top-p.top)<8,inside:r.left>=p.left-1 && r.right<=p.right+1 && r.left>=0 && r.right<=innerWidth}; })()`);
     if (box.w/box.h<1.5 || !box.inside || !box.right || !box.top) failures.push(`${width}/${size}/${theme}: ${id} switch shape/fit ${JSON.stringify(box)}`);
     if ((width===1440&&size===16&&theme==='dark') || (width===390&&size===32&&theme==='light')) await shot(`settings-rows-${width}-${size}-${theme}-${id}`);
    }

   }
   const result = await ev(`(() => { const root=document.getElementById('settings-modal'); return {
    boxes:[...root.querySelectorAll('input[type=checkbox]')].filter(i=>!i.matches('.switch')&&!i.closest('.settings-inbox-teams,.settings-dropbox-types,.sv-choices,#settings-dropbox-offload-confirm')).map(i=>i.id),
    buttons:[...root.querySelectorAll('button')].filter(b=>/^Learn more/.test(b.textContent.trim())).map(b=>b.outerHTML.slice(0,180)),
    links:[...root.querySelectorAll('a.sv-learn,a.settings-learn')].map(a=>({text:a.textContent.trim(),href:a.getAttribute('href'),help:!!a.closest('.sv-help')})),
    help:[...root.querySelectorAll('.sv-help')].filter(e=>e.getClientRects().length).map(e=>({size:getComputedStyle(e).fontSize,color:getComputedStyle(e).color})),
   }; })()`);
   if (result.boxes.length) failures.push(`${width}/${size}/${theme}: raw on/off ${result.boxes}`);
   if (result.buttons.length) failures.push(`${width}/${size}/${theme}: Learn more buttons ${JSON.stringify(result.buttons)}`);
   if (!result.links.length || result.links.some(a=>a.text!=='Learn more'||!a.href.startsWith('/docs/')||!a.help)) failures.push(`${width}/${size}/${theme}: Docs link outside help ${JSON.stringify(result.links)}`);
   // The actual native switch remains keyboard operable and has its original accessible label.
   await ev(`document.getElementById('settings-tab-general').click(); document.getElementById('settings-group-by-team').focus(); true`);
   const before=await ev(`document.getElementById('settings-group-by-team').checked`);
   await Input.dispatchKeyEvent({type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32}); await Input.dispatchKeyEvent({type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
   assert.equal(await ev(`document.getElementById('settings-group-by-team').checked`),!before,'Space toggles the shared switch');
  }
  assert.deepEqual(failures,[]);
 } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
