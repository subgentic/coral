// #20553: an explicit local click opens supported chat files in the system browser.
// Fake the opener route: this suite never launches the person's real browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { themeJs } = require('./helpers/theme');
(async () => {
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const shot=async name=>{if(!process.env.CORAL_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});const {data}=await Page.captureScreenshot({format:'png'});fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR,name+'.png'),Buffer.from(data,'base64'));};
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390])for(const theme of ['light','dark']){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:process.env.CORAL_TEST_URL+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`window.__m.add('browser-agent','B',1,{session_id:'browser-1'}); T.render.renderLiveSessions(T.state.liveSessions); window.switchNavTab('agents'); ${themeJs(theme)}; window.__opens=[]; window.__failOpen=false; const original=window.fetch; window.fetch=(u,o)=>{const s=String(u); if(s.includes('/resolve-path?')){const p=new URL(s,location.href).searchParams.get('filepath').replace(/:3$/,'');return Promise.resolve(new Response(JSON.stringify({filepath:'/project/'+p,line:3}),{headers:{'Content-Type':'application/json'}}));}if(s.includes('/api/system/editors'))return Promise.resolve(new Response('{"editors":[]}',{headers:{'Content-Type':'application/json'}}));if(s.includes('/open-in-browser')){window.__opens.push({url:s,method:o.method,body:JSON.parse(o.body)});return Promise.resolve(new Response(window.__failOpen?'{"error":"Browser unavailable"}':'{"ok":true}',{status:window.__failOpen?400:200,headers:{'Content-Type':'application/json'}}));}return original(u,o);}; true`);
   await ev(`window.selectLiveSession('browser-agent','claude','browser-1','local').then(()=>true)`);
   // Selection starts the transcript fetch; its first render can replace an injected bubble.
   await coralReady(ev,'agentSelected','browser-1');
   await ev(`Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)`);
   const menu=async ref=>{
    await ev(`(()=>{document.querySelector('.chat-file-menu')?.remove();const box=document.getElementById('live-history-messages');box.innerHTML='';box.scrollTop=0;const p=document.createElement('p');p.className='chat-bubble';p.textContent='The prototype is ready: ';const b=document.createElement('button');b.className='chat-file-ref';b.dataset.fileRef=${JSON.stringify(ref)};b.textContent=${JSON.stringify(ref)};p.append(b);box.append(p);window.__menuRef=b;b.click();return true;})()`);
    await waitFor(`!!document.querySelector('.chat-file-menu')`,'file menu',5000,`({connected:window.__menuRef?.isConnected,requests:window.__m.requests})`);
   };
   await menu('index.html:3');await ev(`document.fonts.ready.then(()=>true)`);await shot(width+'-'+theme+'-menu');
   const button=await ev(`(()=>{const b=document.querySelector('.chat-file-menu [data-action=browser]');return b&&{text:b.textContent,title:b.title,icon:b.querySelector('.material-icons').textContent};})()`);
   assert.ok(button,'HTML has Open in browser');assert.match(button.text,/Open in browser/);assert.equal(button.icon,'open_in_browser');assert.match(button.title,/scripts.*run/i);assert.deepEqual(await ev(`window.__opens`),[],'opening menu does not launch');
   await ev(`document.querySelector('.chat-file-menu [data-action=browser]').focus();true`);
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   await waitFor(`window.__opens.length===1`,'explicit Enter calls opener');
   assert.deepEqual(await ev(`window.__opens[0]`),{url:'/api/sessions/live/browser-agent/open-in-browser',method:'POST',body:{filepath:'index.html:3',session_id:'browser-1'}});
   for(const ref of ['other.HTM','image.SvG']){await menu(ref);assert.equal(await ev(`!!document.querySelector('.chat-file-menu [data-action=browser]')`),true);}
   for(const ref of ['notes.md','script.js','coral://artifacts/'+'a'.repeat(64)]){await menu(ref);assert.equal(await ev(`!!document.querySelector('.chat-file-menu [data-action=browser]')`),false,ref);}
   await ev(`window.__failOpen=true;true`);await menu('index.html');await ev(`document.querySelector('.chat-file-menu [data-action=browser]').click();true`);await waitFor(`document.body.textContent.includes('Browser unavailable')`,'opener failure toast');
   await ev(`T.state.servers.push({id:'remote',label:'Other computer',url:'http://other.invalid'});T.state.currentSession.server='remote';true`);
   await menu('index.html');assert.equal(await ev(`document.querySelector('.chat-file-menu [data-action=browser]').getAttribute('aria-disabled')`),'true');const n=await ev(`window.__opens.length`);await ev(`document.querySelector('.chat-file-menu [data-action=browser]').click();true`);assert.equal(await ev(`window.__opens.length`),n,'remote file never launches locally');
  }
  console.log('PASS chat browser menu: explicit local action, file types, keyboard, failure and remote refusal');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
