// #21881: local enrollment QR is a waiting-only image, not a secret in a request URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const png = fs.readFileSync(path.join(__dirname,'fixtures/enroll_qr.png')).toString('base64');
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const errors=[],requests=[]; let paused=[],hold=false;
 const answer=e=>client.Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'},{name:'Cache-Control',value:'no-store'}],body:png});
 await client.Fetch.enable({patterns:[{urlPattern:'*/api/cloud/enroll-qr*',resourceType:'Image'}]});
 safePaused(client,async e=>{requests.push(e.request.url);if(hold){paused.push(e);await ev('window.__qrImagePaused=true;true')}else await answer(e)});
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setTimezoneOverride({timezoneId:'UTC'});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:width===390?844:900,deviceScaleFactor:1,mobile:width===390});
   await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(async()=>{await window.__coral.buildAllLazy();const real=fetch;window.__st={configured:true,state:'enrolling',hub_url:'https://hub.example',computer_fingerprint:'ABCD-EFGH-JKLM-NPQR',user_code:'WXYZ-1234',verification_url:'https://hub.example/enroll?code=WXYZ-1234',expires_at:'2099-11-27T12:00:00Z',enroll_qr_expires_at:'2099-11-27T12:00:00Z',max_mode:'view',max_mode_saved:true};window.fetch=(u,o)=>String(u).endsWith('/api/cloud/status')?Promise.resolve(new Response(JSON.stringify(window.__st),{headers:{'Content-Type':'application/json'}})):real(u,o);window.__cc=await import((window.__coralStatic||'/static/')+'cloud_connect.js');window.__cc.initCloudConnect();document.getElementById('settings-cloud')._cloudPanel.pairingSecret='AAAAAAAAAAAAAAAAAAAAAA';await window.showSettingsModal('network');return true})()`);
   await waitFor(`!!document.getElementById('settings-cloud-code')&&!document.getElementById('settings-cloud-code').hidden`,'waiting enrollment',10000);
   const qrReady=await waitFor(`document.querySelector('#settings-cloud [data-cloud="qr"] img')?.naturalWidth===256`,'QR readiness for the same screenshot probe',8000).then(()=>true,()=>false);
   if(process.env.CORAL_SCREENSHOT_DIR){await ev(`document.getElementById('settings-cloud').scrollIntoView({block:'start'});document.fonts.ready.then(()=>${framesJs(2)})`);fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/enrollment-qr-${width}.png`,Buffer.from((await Page.captureScreenshot()).data,'base64'))}
   try{
    assert.ok(qrReady, 'QR image loads beside the enrollment link');
    await waitFor(`document.querySelector('#settings-cloud [data-cloud="qr"] img')?.naturalWidth===256&&!document.querySelector('#settings-cloud [data-cloud="qr"]').hidden`,'QR loads',5000);
    assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`),true,width+': no page overflow');
    assert.equal(await ev(`document.querySelector('#settings-cloud [data-cloud="link"]').href==='https://hub.example/enroll?code=WXYZ-1234#p=AAAAAAAAAAAAAAAAAAAAAA'`),true,'existing link keeps the same enrollment capability');
    assert.equal(await ev(`document.querySelector('#settings-cloud [data-cloud="computer-key"]').textContent`),'ABCD-EFGH-JKLM-NPQR','computer key stays available to compare');
    const bounds=await ev(`(()=>{const r=document.querySelector('#settings-cloud [data-cloud="qr"] img').getBoundingClientRect();return {left:r.left,right:r.right,w:innerWidth}})()`);assert.ok(bounds.left>=0&&bounds.right<=bounds.w,width+': QR inside viewport');
    for(const state of ['idle','connected','connecting','revoked']){
     await ev(`window.__st.state=${JSON.stringify(state)};window.__cc.loadCloudStatus()`);
     assert.equal(await ev(`!!document.querySelector('#settings-cloud [data-cloud="qr"] img')`),false,state+': image removed');
     await ev(`window.__st.state='enrolling';window.__cc.loadCloudStatus()`);
     await waitFor(`document.querySelector('#settings-cloud [data-cloud="qr"] img')?.naturalWidth===256`,'waiting image returns',5000);
    }
    // Delay an old image response, cancel, then deliver it: it cannot reappear.
    hold=true;await ev(`window.__qrImagePaused=false;window.__st.user_code='NEXT-5678';window.__cc.loadCloudStatus()`);
    await waitFor(`document.querySelector('#settings-cloud [data-cloud="qr"] img')?.getAttribute('src')?.includes('g=')`,'replacement image',5000);
    await waitFor(`window.__qrImagePaused===true`,'old image response held',5000);
    await ev(`window.__st.state='idle';window.__cc.loadCloudStatus()`);
    hold=false;for(const p of paused.splice(0))await answer(p).catch(()=>{});
    await ev(framesJs(2));assert.equal(await ev(`!!document.querySelector('#settings-cloud [data-cloud="qr"] img')`),false,'late old image stays removed');
    await ev(`window.__st.state='enrolling';window.__cc.loadCloudStatus()`);
    await waitFor(`document.querySelector('#settings-cloud [data-cloud="qr"] img')?.naturalWidth===256`,'image before stop',5000);
    await ev(`window.__st.enroll_qr_expires_at=new Date(Date.now()+100).toISOString();window.__cc.loadCloudStatus()`);
    await waitFor(`!document.querySelector('#settings-cloud [data-cloud="qr"] img')`,'expiry removes image without waiting for status',3000);
    await ev(`window.__st.enroll_qr_expires_at='2099-11-27T12:00:00Z';window.__cc.loadCloudStatus()`);
    await waitFor(`document.querySelector('#settings-cloud [data-cloud="qr"] img')?.naturalWidth===256`,'image before disposal',5000);
    await ev(`window.hideSettingsModal(true);true`);
    assert.equal(await ev(`!!document.querySelector('#settings-cloud [data-cloud="qr"] img')`),false,'closing Settings removes image');
    await ev(`window.showSettingsModal('network')`);
    await waitFor(`document.querySelector('#settings-cloud [data-cloud="qr"] img')?.naturalWidth===256`,'reopening Settings resumes image',8000);
    await ev(`document.getElementById('settings-cloud')._cloudPanel.stop();true`);
    assert.equal(await ev(`!!document.querySelector('#settings-cloud [data-cloud="qr"] img')`),false,'dispose removes image');
   }catch(e){errors.push(width+': '+e.message)}
  }
  assert.deepEqual(errors,[]);
  assert.ok(requests.length>0);assert.ok(requests.every(u=>{const q=new URL(u);return !q.hash&&[...q.searchParams].every(([k,v])=>k==='g'&&/^\d+$/.test(v))}),'QR requests carry at most a generation counter');
  console.log('PASS enrollment QR at 1280/390, lifecycle, stale loads, disposal and secret-free URLs');
 }finally{hold=false;for(const p of paused.splice(0))await answer(p).catch(()=>{});await client.close()}
})().catch(e=>{console.error(e);process.exit(1)});
