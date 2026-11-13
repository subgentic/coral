// ST1c: ordinary backup filters save themselves; destructive day counts still preview first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
(async () => {
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const failures=[];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1440,390]) for(const theme of ['light','dark']) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:process.env.CORAL_TEST_URL+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(()=>{document.documentElement.dataset.theme='${theme}';localStorage.setItem('theme','${theme}');const real=fetch;window.__writes=[];window.__fail=false;window.__db={app_key_set:true,app_key:'abcdefghijklmnop',connected:true,state:'connected',backup:{backed_up:4},filters:{types:[],max_age_days:0},retention:{days:0},offload:{days:0}};window.fetch=(u,o={})=>{const p=new URL(String(u),location.origin).pathname;const json=(b,s=200)=>Promise.resolve(new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json'}}));if(p==='/api/dropbox/status')return json(__db);if(p==='/api/dropbox/shares')return json({shares:[]});if(p.startsWith('/api/dropbox/')&&o.method==='PUT'){const b=JSON.parse(o.body);__writes.push({p,b});if(__fail)return json({error:'Test refusal'},500);if(p.endsWith('/filters')){__db.filters=b;return json(b);}if(p.endsWith('/retention')){if(!b.days||b.confirm){__db.retention={days:b.days};return json({days:b.days});}return json({dry_run:true,days:b.days,due:2,bytes:2048});}if(p.endsWith('/offload')){if(!b.days||b.confirm){__db.offload={days:b.days};return json({days:b.days});}return json({count:2,bytes:2048,risk:'Keep a backup',warning:'Files leave this computer'});}}return real(u,o);};return true;})()`);
   await ev(`window.showSettingsModal('cleanup');true`);await waitFor(`!!document.getElementById('settings-dropbox-age')&&!document.getElementById('settings-dropbox-backup').hidden`,'connected Dropbox settings');
   await ev(`document.getElementById('settings-dropbox-types').scrollIntoView({block:'center'});true`);
   if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/dropbox-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   const hasSave=await ev(`!!document.querySelector('#settings-dropbox-filters-save,#settings-dropbox-retention-save,#settings-dropbox-offload-save')`);
   if(hasSave){failures.push(width+' '+theme+': manual Save buttons remain');continue;}
   await ev(`(()=>{const i=document.getElementById('settings-dropbox-age');i.value='7';i.dispatchEvent(new Event('focusout',{bubbles:true}));return true;})()`);
   await waitFor(`__db.filters.max_age_days===7`,'age autosaved');
   await ev(`(()=>{const i=document.querySelector('#settings-dropbox-types input');i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`__db.filters.types.length===1`,'type autosaved');
   await ev(`import((window.__coralStatic||'/static/')+'dropbox_settings.js').then(m=>m.loadDropbox()).then(()=>true)`);
   assert.equal(await ev(`document.getElementById('settings-dropbox-age').value`),'7','reload keeps saved age');
   await ev(`(()=>{const i=document.getElementById('settings-dropbox-keep-for');i.value='30';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
   await waitFor(`!document.getElementById('settings-dropbox-retention-on').hidden`,'retention preview');assert.equal(await ev(`__db.retention.days`),0,'preview deletes nothing');
   await ev(`document.getElementById('settings-dropbox-retention-cancel').click();true`);assert.equal(await ev(`document.getElementById('settings-dropbox-keep-for').value`),'0');
   await ev(`(()=>{const i=document.getElementById('settings-dropbox-offload-for');i.value='30';i.dispatchEvent(new Event('focusout',{bubbles:true}));return true;})()`);
   await waitFor(`!document.getElementById('settings-dropbox-offload-confirm').hidden`,'offload preview');assert.equal(await ev(`__db.offload.days`),0);assert.equal(await ev(`document.querySelector('#settings-dropbox-offload-confirm button').disabled`),true,'risk acknowledgments required');
   await ev(`[...document.querySelectorAll('#settings-dropbox-offload-confirm button')].find(b=>b.textContent==='Cancel').click();__fail=true;const i=document.getElementById('settings-dropbox-age');i.value='8';i.dispatchEvent(new Event('focusout',{bubbles:true}));true`);
   await waitFor(`document.getElementById('settings-dropbox-age').value==='7'`,'failed save rolls back');
   assert.equal(await ev(`!![...document.querySelectorAll('#settings-dropbox [role=status]')].find(e=>/Not saved/.test(e.textContent))`),true,'row error is announced');
  }
  assert.deepEqual(failures,[]);console.log('PASS Dropbox autosave and confirmation boundaries in both themes at desktop and phone widths');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
