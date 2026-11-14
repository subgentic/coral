// #16006: the native share dialog grows to its form, then only its body scrolls.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const errors=[];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1440,1024,768,390,320]) for(const theme of ['dark','light']) for(const size of [16,32]) {
   await Emulation.setDeviceMetricsOverride({width,height:1200,deviceScaleFactor:1,mobile:width<700});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(async()=>{ document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${size}px'; document.documentElement.classList.toggle('light-theme','${theme}'==='light'); const original=window.fetch; window.fetch=(u,o)=>new URL(String(u),location.origin).pathname.startsWith('/api/dropbox/share/')?Promise.resolve(new Response(JSON.stringify({connected:true,name:'release-plan.md',size:2048,version:1,shares:[],secret:false,can_expire:true}),{status:200,headers:{'Content-Type':'application/json'}})):original(u,o); const m=await import((window.__coralStatic||'/static/')+'dropbox_share.js');await m.openShareDialog({hex:'a'.repeat(64),filename:'release-plan.md'});return true;})()`);
   await waitFor(`!!document.querySelector('#dropbox-share-emails')`,'share form');
   await ev(`document.fonts.ready.then(()=>true)`);await ev(framesJs(2));
   const measure=()=>ev(`(()=>{const d=document.getElementById('dropbox-share-dialog'),b=d.querySelector('.modal-body'),f=d.querySelector('.modal-footer'),r=d.getBoundingClientRect(),br=b.getBoundingClientRect(),fr=f.getBoundingClientRect();return {height:b.clientHeight,content:b.scrollHeight,body:br.height,footer:fr.bottom,top:r.top,bottom:r.bottom,width:r.width,scroll:getComputedStyle(d).overflowY};})()`);
   const basis=await ev(`getComputedStyle(document.querySelector('.dropbox-share-body')).flexBasis`);if(basis!=='auto')errors.push(width+'/'+theme+'/'+size+': WebKit content sizing needs auto flex basis, got '+basis); let g=await measure();
   console.log(JSON.stringify({width,theme,size,...g})); if(size===16 && g.height+2<g.content)errors.push(width+'/'+theme+': body collapsed at full height '+JSON.stringify(g));
   if(g.footer>1201||g.top<0||g.width>width)errors.push(width+'/'+theme+': dialog outside viewport '+JSON.stringify(g));
   if(process.env.CORAL_SCREENSHOT_DIR && [1440,390].includes(width)){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/dropbox-share-${width}-${theme}-${size}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   await Emulation.setDeviceMetricsOverride({width,height:600,deviceScaleFactor:1,mobile:width<700});
   await ev(framesJs(2));
   g=await measure(); const clipped=await ev(`(()=>{const b=document.querySelector('.dropbox-share-body');return [...b.children].filter(e=>e.getClientRects().length && e.scrollHeight>e.clientHeight+2).map(e=>({tag:e.tagName,cls:e.className,h:e.clientHeight,scroll:e.scrollHeight}));})()`);if(clipped.length)errors.push(width+'/'+theme+'/'+size+': body children shrink and clip '+JSON.stringify(clipped)); if(g.footer>601||g.top<0||g.body<Math.min(g.content,200))errors.push(width+'/'+theme+': short viewport loses body/footer '+JSON.stringify(g));
   await ev(`document.getElementById('dropbox-share-dialog').close();true`);
  }
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('PASS Dropbox share body grows to content; footer stays visible at five widths in both themes');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
