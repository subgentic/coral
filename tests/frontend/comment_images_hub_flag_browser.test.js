// #20717: actual artifact comment forms follow the Hub account's image capability.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'd'.repeat(64), IMAGE = 'e'.repeat(64);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
(async () => {
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {Fetch,Network}=client;let cloud=false;const failures=[];
 const check=(ok,why)=>{if(!ok)failures.push(why);};
 try {
  await Page.enable();await Network.setBypassServiceWorker({bypass:true});
  await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Fetch.enable({patterns:[{urlPattern:BASE+'/*',resourceType:'Document',requestStage:'Response'}]});
  safePaused(client,async e=>{
   const r=await Fetch.getResponseBody({requestId:e.requestId});let html=r.base64Encoded?Buffer.from(r.body,'base64').toString():r.body;
   if(cloud)html=html.replace('"mode":"local"','"mode":"cloud"');
   await Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:[...(e.responseHeaders||[]).filter(h=>!/^content-length$|^content-security-policy$/i.test(h.name)),{name:'Content-Security-Policy',value:"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws:"}],body:Buffer.from(html).toString('base64')});
  });
  for(const config of [{cloud:true,width:1280,theme:'light',name:'absent'},{cloud:true,flag:false,width:390,theme:'dark',name:'false'},{cloud:true,flag:true,width:390,theme:'light',name:'true'},{cloud:false,flag:false,width:1280,theme:'dark',name:'local'}]) {
   cloud=config.cloud;const enabled=!cloud||config.flag===true;
   const account={comment_writes:true,comment_send:true,...(config.flag===undefined?{}:{comment_images:config.flag})};
   const preload=await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{
    const real=window.fetch,json=x=>Promise.resolve(new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}}));window.__uploads=[];
    window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;
     if(p==='/api/account')return json(${JSON.stringify(account)});
     if(p==='/auth/session')return json({authenticated:true,email:'tester@example.com',csrf:'test'});
     if(p==='/api/servers')return json({servers:[{id:'m2',label:'Laptop',online:true,status:'online',access_mode:'interact',owner_stamp:true}]});
     if(p.endsWith('/api/team-artifacts'))return json({artifacts:[],has_more:false});
     if(p.endsWith('/api/artifacts/${HEX}/comment-images')){window.__uploads.push(p);return json({hex:'${IMAGE}',name:'picture.png',content_type:'image/png',size:4});}
     if(p.endsWith('/api/artifacts/${HEX}/comments'))return json({comments:[],locked:false,you:{kind:'owner',can_comment:true,can_lock:true},limits:{}});
     if(p.endsWith('/api/artifacts/${HEX}'))return Promise.resolve(new Response('# Review plan',{headers:{'content-type':'text/markdown'}}));
     return real(u,o);
    };})();`});
   await Emulation.setDeviceMetricsOverride({width:config.width,height:900,deviceScaleFactor:1,mobile:config.width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');
   await ev(`document.documentElement.setAttribute('data-theme','${config.theme}');T.state.servers=[{id:'m2',label:'Laptop',online:true,status:'online',owner_stamp:true}];T.state.serversKnown=true;import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m=>{m.openArtifactViewer('${HEX}',{filename:'plan.md',server:'${cloud?'m2':'local'}',board:'picture-review'});return true;})`);
   await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`,'document '+config.name).catch(async e=>{throw new Error(e.message+' '+JSON.stringify(await ev(`({body:document.querySelector('#artifact-viewer')?.textContent.slice(0,300),toasts:[...document.querySelectorAll('.toast')].map(e=>e.textContent),boot:document.getElementById('coral-boot').textContent,servers:T.state.servers,known:T.state.serversKnown})`)));});
   await waitFor(`!!document.querySelector('.ac-toggle:not([hidden])')`,'comments '+config.name);
   if(!(await ev(`document.querySelector('.ac-panel').getClientRects().length>0`)))await ev(`document.querySelector('.ac-toggle').click();true`);
   await waitFor(`!!document.querySelector('.ac-whole')`,'whole document '+config.name);
   await ev(`document.querySelector('.ac-whole').click();true`);
   await waitFor(`!!document.querySelector('.ac-composer .ac-input')`,'composer '+config.name);
   const ui=await ev(`(()=>{const c=document.querySelector('.ac-composer');return {pick:!!c.querySelector('.ac-add-image'),input:!!c.querySelector('input[type=file]'),hint:c.querySelector('.ac-images-hint')?.textContent,reviewPick:!!document.querySelector('.artifact-review-form .ac-add-image')};})()`);
   check(ui.pick===enabled&&ui.input===enabled&&ui.reviewPick===enabled,config.name+': picker capability '+JSON.stringify(ui));
   if(!enabled)check(ui.hint==="Pictures aren't available through the Hub yet.",config.name+': plain unavailable line '+ui.hint);
   await ev(framesJs(3));
   if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/'+config.name+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   await ev(`(()=>{const c=document.querySelector('.ac-composer'),field=c.querySelector('textarea');const files=()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0))],'picture.png',{type:'image/png'}));return d;};field.dispatchEvent(new ClipboardEvent('paste',{clipboardData:files(),bubbles:true,cancelable:true}));c.dispatchEvent(new DragEvent('dragover',{dataTransfer:files(),bubbles:true,cancelable:true}));c.dispatchEvent(new DragEvent('drop',{dataTransfer:files(),bubbles:true,cancelable:true}));return true;})()`);
   await ev(framesJs(3));
   if(enabled)await waitFor(`window.__uploads.length===2`,'paste and drop upload '+config.name);
   check(await ev(`window.__uploads.length===${enabled?2:0}`),config.name+': disabled paste/drop never upload');
   if(enabled)check(await ev(`window.__uploads.every(u=>u.startsWith('${cloud?'/api/remote/m2/':'/api/'}'))`),config.name+': correct source routing');
   await ev(framesJs(3));

   await Page.removeScriptToEvaluateOnNewDocument(preload);
  }
  assert.deepEqual(failures,[]);console.log('PASS Hub comment image capability: absent/false/true account flags, local unchanged, picker/paste/drop and source routing');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
