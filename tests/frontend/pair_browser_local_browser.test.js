const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {connect}=require('./agent_view_harness'), {coralReady,framesJs}=require('./helpers/wait'),{safePaused}=require('./helpers/paused');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const urls=[],errors=[];
 const png=fs.readFileSync(path.join(__dirname,'fixtures/pair_browser_qr.png')).toString('base64');
 await client.Fetch.enable({patterns:[{urlPattern:'*/api/cloud/enroll-qr*',resourceType:'Image'}]});
 safePaused(client,async e=>{urls.push(e.request.url);await client.Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'}],body:png})});
 try{
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Emulation.setTimezoneOverride({timezoneId:'UTC'});
 for(const width of [1280,390]){
 await Emulation.setDeviceMetricsOverride({width,height:width===390?844:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
 await ev(`(async()=>{await window.__coral.buildAllLazy();await import((window.__coralStatic||'/static/')+'safe_storage.js').then(m=>m.browserLocal.remove('coral-device-notice-dismissed:device_key:phone:1'));const real=fetch;window.__calls=[];window.__notice=false;window.__pair={active:false,max_mode:'launch'};window.__st={configured:true,state:'connected',hub_url:'https://hub.example',max_mode:'launch',max_mode_saved:true};window.fetch=async(u,o={})=>{const p=String(u);if(p.endsWith('/api/cloud/status'))return new Response(JSON.stringify(window.__st));if(p.includes('/api/needs-you?kind=device_key'))return new Response(JSON.stringify({items:window.__notice?[{kind:'device_key',id:'device_key:phone:1',line:'My phone can now act on this computer as interact: PHONE-KEY1-KEY2-KEY3',at:'2026-11-27T12:00:00Z'}]:[],cursor:'2026-11-27T12:00:00Z|phone',counts:{device_key:window.__notice?1:0}}));if(p.includes('/api/cloud/pair-browser')){window.__calls.push({url:p,method:o.method||'GET',body:o.body});if(o.method==='POST'&&p.endsWith('/pair-browser')){if(window.__holdStart)await new Promise(r=>window.__releaseStart=r);window.__pair={active:true,max_mode:'launch',code:'WXYZ1234',link:'https://hub.example/pair?c=WXYZ1234#p=AAAAAAAAAAAAAAAAAAAAAA',fingerprint:'ABCD-EFGH-JKLM-NPQR',expires_at:'2099-11-27T12:00:00Z',pending:{label:'My phone',fingerprint:'PHONE-KEY1-KEY2-KEY3',expires_at:'2099-11-27T12:00:00Z'}};}if(p.endsWith('/allow'))window.__notice=true;if(p.endsWith('/allow')||p.endsWith('/deny')||o.method==='DELETE')window.__pair={active:false,max_mode:'launch',last:p.endsWith('/allow')?'Trusted My phone.':'Pairing was cancelled.'};return new Response(JSON.stringify(window.__pair),{headers:{'Content-Type':'application/json'}})}return real(u,o)};window.__cc=await import((window.__coralStatic||'/static/')+'cloud_connect.js');window.__cc.initCloudConnect();await window.showSettingsModal('network');return true})()`);
 const ready=await waitFor(`!!document.querySelector('#settings-cloud [data-pair="start"]')`,'local pair action',8000).then(()=>true,()=>false);
 if(ready){await ev(`document.querySelector('#settings-cloud [data-pair="start"]').click();true`);await waitFor(`!document.querySelector('#settings-cloud .cloud-pair-ask').hidden`,'pending browser',5000);await waitFor(`document.querySelector('#settings-cloud .cloud-pair-browser img')?.naturalWidth===256`,'pair QR',5000)}
 if(process.env.CORAL_SCREENSHOT_DIR){await ev(`(document.querySelector('#settings-cloud .cloud-pair-browser')||document.getElementById('settings-cloud')).scrollIntoView({block:'start'});document.fonts.ready.then(()=>${framesJs(2)})`);fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/pair-browser-'+width+'.png',Buffer.from((await Page.captureScreenshot()).data,'base64'))}
 try{
 assert.ok(ready,'local Pair action without disconnecting');
 assert.equal(await ev(`document.querySelector('#settings-cloud [data-pair="mode"]').value`),'view');
 assert.equal(await ev(`document.querySelector('#settings-cloud .cloud-pair-ask').textContent.includes('PHONE-KEY1-KEY2-KEY3')&&document.querySelector('#settings-cloud .cloud-pair-ask').textContent.includes('My phone')`),true,'label and fingerprint');
 assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`),true,'no overflow');
 await ev(`document.querySelector('#settings-cloud [data-pair="mode"]').value='interact';document.querySelector('#settings-cloud [data-pair="allow"]').click();true`);
 await waitFor(`window.__calls.some(c=>c.url.endsWith('/allow'))`,'allow',5000);assert.equal(await ev(`JSON.parse(window.__calls.find(c=>c.url.endsWith('/allow')).body).mode`),'interact');
 await waitFor(`!document.querySelector('#settings-cloud .cloud-pair-browser img')`,'success hides QR',5000);
 await ev(`window.hideSettingsModal(true);window.switchNavTab('hub-inbox');true`);await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
 await waitFor(`document.querySelector('[data-device-notice]')?.textContent.includes('My phone can now act on this computer as interact: PHONE-KEY1-KEY2-KEY3')`,'server success notice in Needs you',10000);
 if(process.env.CORAL_SCREENSHOT_DIR){await ev(`document.querySelector('[data-device-notice]').scrollIntoView({block:'center'});document.fonts.ready.then(()=>${framesJs(2)})`);fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/pair-notice-'+width+'.png',Buffer.from((await Page.captureScreenshot()).data,'base64'))}
 await ev(`document.querySelector('[data-device-notice] button').click();true`);assert.equal(await ev(`!!document.querySelector('[data-device-notice]')`),false,'notice dismisses without revoking');
 await ev(`window.showSettingsModal('network')`);await waitFor(`document.querySelector('#settings-cloud [data-pair="start"]')?.offsetParent!==null`,'pair screen returns',5000);

 await ev(`document.querySelector('#settings-cloud [data-pair="start"]').click();true`);await waitFor(`!document.querySelector('#settings-cloud .cloud-pair-ask').hidden`,'replacement',5000);assert.equal(await ev(`document.querySelector('#settings-cloud [data-pair="mode"]').value`),'view');
 await ev(`window.__pair.max_mode='view';true`);await waitFor(`document.querySelector('#settings-cloud [data-pair="mode"]').options.length===1`,'cap',5000);
 await ev(`document.querySelector('#settings-cloud [data-pair="deny"]').click();true`);await waitFor(`window.__calls.some(c=>c.url.endsWith('/deny'))`,'deny',5000);await waitFor(`!document.querySelector('#settings-cloud .cloud-pair-browser img')`,'deny hides QR',5000);
 await ev(`document.querySelector('#settings-cloud [data-pair="start"]').click();true`);await waitFor(`!!document.querySelector('#settings-cloud .cloud-pair-browser img')`,'before close',5000);await ev(`window.hideSettingsModal(true);true`);assert.equal(await ev(`!!document.querySelector('#settings-cloud .cloud-pair-browser img')`),false);await waitFor(`window.__calls.some(c=>c.method==='DELETE')`,'close cancels',5000);
 await ev(`window.showSettingsModal('network')`);await waitFor(`document.querySelector('#settings-cloud [data-pair="start"]')?.offsetParent!==null`,'reopen',5000);
 await ev(`window.__holdStart=true;document.querySelector('#settings-cloud [data-pair="start"]').click();true`);await waitFor(`typeof window.__releaseStart==='function'`,'start response held',5000);
 await ev(`window.hideSettingsModal(true);window.__releaseStart();true`);await waitFor(`window.__calls.filter(c=>c.method==='DELETE').length>=2`,'late Start cancelled after Close',5000);
 assert.equal(await ev(`!!document.querySelector('#settings-cloud .cloud-pair-browser img')`),false,'late Start cannot restore QR');
 assert.equal(await ev(`window.__calls.some(c=>c.url.includes('disconnect'))`),false);
 }catch(e){errors.push(width+': '+e.message)}
 }
 assert.deepEqual(errors,[]);assert.ok(urls.length);assert.ok(urls.every(u=>{const p=new URL(u);return !p.hash&&[...p.searchParams].every(([k,v])=>k==='g'&&/^\d+$/.test(v))}));
 console.log('PASS local pair: 1280/390, identity, mode, Allow/Deny, disposal and secret-free requests');
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exit(1)});
