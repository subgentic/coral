// Shared artifact thumbnail loading: fixed geometry, source scope, lazy 200-row
// work, safe type fallbacks, and row replacement while bytes are pending.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const {coralReady,framesJs} = require('./helpers/wait');
const {setTheme} = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','settings');
   await ev(`(async()=>{
    const S=window.__coralStatic||'/static/';const {artifactTable}=await import(S+'artifact_table.js');const {artifactThumbnail}=await import(S+'artifact_thumbnail.js');
    const real=window.fetch,canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;canvas.getContext('2d').fillRect(0,0,8,8);
    const raw=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
    window.__thumb={requests:[],active:0,peak:0,hold:true,gates:[],started:performance.now()};
    window.fetch=(u,o={})=>{
     const p=new URL(String(u),location.href);if(!p.pathname.endsWith('/thumbnail'))return real(u,o);
     const q=window.__thumb;q.requests.push(p.pathname);q.active++;q.peak=Math.max(q.peak,q.active);
     const reply=()=>{q.active--;return new Response(raw,{headers:{'Content-Type':'image/png'}})};
     if(!q.hold)return Promise.resolve(reply());
     return new Promise((resolve,reject)=>{q.gates.push(()=>resolve(reply()));o.signal?.addEventListener('abort',()=>{q.active--;reject(new DOMException('aborted','AbortError'))},{once:true})});
    };
    const host=document.createElement('main');host.id='thumbnail-probe';host.style.cssText='position:fixed;inset:0;z-index:10000;background:var(--bg-primary);overflow:auto';
    const box=document.createElement('section');box.id='thumbnail-scroll';box.style.cssText='height:300px;overflow:auto';host.append(box);document.body.append(host);
    const rows=Array.from({length:200},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:'Picture '+i+'.png',media_type:'image/png',size:100,created_at:'2026-11-01T00:00:00Z'}));
    const url=i=>'/api/remote/m2/api/artifacts/'+i.id+'/thumbnail';
    const baselineStart=performance.now();box.append(artifactTable({rows,mail:i=>({lead:{icon:'description'},title:i.name})}).el);
    window.__thumb.iconOnlyBuildMs=performance.now()-baselineStart;box.replaceChildren();window.__thumb.started=performance.now();
    box.append(artifactTable({rows,thumbnailURL:url,open:()=>window.__thumb.opened=true,mail:i=>({lead:{node:artifactThumbnail(i,{size:32,url:url(i)})},title:i.name})}).el);
    const unsupported=document.createElement('section');unsupported.id='thumbnail-unsupported';host.append(unsupported);
    for(const [name,type] of [['Clip.mp4','video/mp4'],['Sheet.pdf','application/pdf'],['Readme.md','text/markdown'],['Page.html','text/html'],['Vector.svg','image/svg+xml']])unsupported.append(artifactThumbnail({id:'f'.repeat(64),name,media_type:type},{url:'/api/remote/m2/api/artifacts/'+ 'f'.repeat(64)+'/thumbnail'}));
    window.__thumb.buildMs=performance.now()-window.__thumb.started;return true;
   })()`);
   await waitFor('window.__thumb.active===2','only two lazy thumbnail reads start');
   await ev(framesJs(2));await ev('window.__thumb.paintMs=performance.now()-window.__thumb.started;true');
   assert.equal(await ev('window.__thumb.requests.length'),2,'held reads do not start all 200 files');
   const before=await ev(`({height:document.querySelector('#thumbnail-scroll tbody tr').getBoundingClientRect().height,scroll:document.querySelector('#thumbnail-scroll').scrollHeight})`);
   await ev(`window.__thumb.hold=false;window.__thumb.gates.splice(0).forEach(r=>r());true`);
   await waitFor(`document.querySelector('#thumbnail-scroll .artifact-thumbnail-image')&&window.__thumb.active===0`,'visible thumbnails finish');await ev(framesJs(3));
   const measured=await ev(`({requests:window.__thumb.requests,peak:window.__thumb.peak,buildMs:window.__thumb.buildMs,iconOnlyBuildMs:window.__thumb.iconOnlyBuildMs,paintMs:window.__thumb.paintMs,height:document.querySelector('#thumbnail-scroll tbody tr').getBoundingClientRect().height,scroll:document.querySelector('#thumbnail-scroll').scrollHeight})`);
   assert.ok(measured.requests.length<40,'offscreen rows stay lazy');assert.equal(measured.peak,2);assert.equal(measured.height,before.height);assert.equal(measured.scroll,before.scroll);
   assert.ok(measured.requests.every(p=>p.startsWith('/api/remote/m2/api/artifacts/')&&!p.includes('f'.repeat(64))),'all image reads stay on the captured computer; unsupported types never read bytes');
   assert.equal(await ev(`(()=>{const b=[...document.querySelectorAll('#thumbnail-scroll tbody .dt-primary')].find(e=>e.getClientRects().length);b.click();return window.__thumb.opened===true})()`),true,'the original filename action still opens its row');
   for(const theme of ['dark','light'])for(const scale of [1,2]){
    await setTheme(ev,theme);await ev(`document.documentElement.style.fontSize='${16*scale}px';true`);
    assert.equal(await ev(`document.querySelector('#thumbnail-probe').scrollWidth<=innerWidth+1`),true,theme+' '+scale+'x has no horizontal overflow');
    const decorative=await ev(`Array.from(document.querySelectorAll('#thumbnail-probe .artifact-thumbnail')).every(n=>n.getAttribute('aria-hidden')==='true'&&!n.hasAttribute('tabindex'))`);assert.equal(decorative,true);
   }
   await ev(`document.documentElement.style.fontSize='16px';document.querySelector('#thumbnail-scroll').scrollTop=100000;true`);
   await waitFor(`window.__thumb.requests.some(p=>p.endsWith('/'+(200).toString(16).padStart(64,'0')+'/thumbnail'))`,'scrolling loads the final rows');
   assert.ok(await ev('window.__thumb.requests.length<80'),'scrolling to the end does not eagerly load the middle');
   await ev(`(async()=>{
    const {artifactThumbnail}=await import((window.__coralStatic||'/static/')+'artifact_thumbnail.js');
    const original=window.fetch,host=document.querySelector('#thumbnail-probe'),late='a'.repeat(64),denied='b'.repeat(64);
    window.__late={requested:0,aborted:0};
    window.fetch=(u,o={})=>{
     const path=new URL(String(u),location.href).pathname;
     if(path.endsWith('/'+denied+'/thumbnail'))return Promise.resolve(new Response('denied',{status:403}));
     if(path.endsWith('/'+late+'/thumbnail')){window.__late.requested++;return new Promise((resolve,reject)=>{window.__late.release=()=>resolve(new Response('late',{headers:{'content-type':'image/png'}}));o.signal.addEventListener('abort',()=>{window.__late.aborted++;reject(new DOMException('aborted','AbortError'))},{once:true})})}
     return original(u,o);
    };
    const a=artifactThumbnail({id:late,name:'Late.png',media_type:'image/png'},{url:'/api/remote/m2/api/artifacts/'+late+'/thumbnail'});a.id='late-thumbnail';
    const b=artifactThumbnail({id:denied,name:'Denied.png',media_type:'image/png'},{url:'/api/remote/m2/api/artifacts/'+denied+'/thumbnail'});b.id='denied-thumbnail';
    host.replaceChildren(a,b);return true;
   })()`);
   await waitFor('window.__late.requested===1','pending image read starts');
   await ev(`(async()=>{const {artifactThumbnail}=await import((window.__coralStatic||'/static/')+'artifact_thumbnail.js');const old=document.querySelector('#late-thumbnail'),next=artifactThumbnail({name:'Replacement.html',media_type:'text/html'});next.id='replacement-thumbnail';old.replaceWith(next);return true;})()`);
   await waitFor('window.__late.aborted===1','removing a row aborts its image read');
   await ev(`window.__late.release();true`);await ev(framesJs(3));
   assert.equal(await ev(`!!document.querySelector('#replacement-thumbnail svg')&&!document.querySelector('#replacement-thumbnail img')`),true,'a late answer never paints the replacement row');
   assert.equal(await ev(`!!document.querySelector('#denied-thumbnail svg')&&!document.querySelector('#denied-thumbnail img')`),true,'denied images retain the icon');
   console.log(width+'px 200-row measurement '+JSON.stringify(measured));
  }
 }finally{await client.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
