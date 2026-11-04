// #13175: real recorded WebM in the artifact viewer, with a stubbed comments API.
// One suite covers playback/seek, zero timestamps, ranges, resolve/reopen, phone,
// 200% text, both themes and the cloud read-only permission surface.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { safePaused } = require('./helpers/paused');
const HEX = '9'.repeat(64), OLD = '8'.repeat(64);
(async () => {
 const h = await connect(); const {client,Page,Emulation,ev,waitFor,install}=h;
 const {Fetch,Input}=client;
 let cloud=false;
 await Fetch.enable({patterns:[{urlPattern:BASE+'/',requestStage:'Response',resourceType:'Document'}]});
 safePaused(client, async e=>{
  const r=await Fetch.getResponseBody({requestId:e.requestId});
  let html=r.base64Encoded?Buffer.from(r.body,'base64').toString():r.body;
  if(cloud)html=html.replace('"mode":"local"','"mode":"cloud"');
  await Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:(e.responseHeaders||[]).filter(x=>!/^content-length$/i.test(x.name)),body:Buffer.from(html).toString('base64')});
 });
 const shot=async name=>{if(!process.env.CORAL_SCREENSHOT_DIR)return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});const s=await Page.captureScreenshot({format:'png'});fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR,name+'.png'),Buffer.from(s.data,'base64'));};
 try {
  for(const config of [{width:1280,theme:'dark'},{width:390,theme:'light'},{width:1280,theme:'light',zoom:true},{width:390,theme:'dark',cloud:true}]) {
   cloud=!!config.cloud;
   await Emulation.setDeviceMetricsOverride({width:config.width,height:900,deviceScaleFactor:1,mobile:config.width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await setTheme(ev,config.theme);
   if(config.zoom)await ev(`document.documentElement.style.fontSize='200%'`);
   await ev(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(10);const rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
    rec.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise(r=>rec.onstop=r);rec.start();
    for(let i=0;i<22;i++){ctx.fillStyle='#18233c';ctx.fillRect(0,0,640,360);ctx.fillStyle='#e9eef7';ctx.font='32px sans-serif';ctx.fillText('Video review sample',50,145);ctx.font='20px sans-serif';ctx.fillText('A small test film · '+i,50,195);await new Promise(r=>setTimeout(r,100));}
    rec.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
    // MediaRecorder omits WebM Duration. Add it to the Info element (milliseconds,
    // TimecodeScale=1,000,000); the Segment has unknown length, so it needs no patch.
    let bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
    for(let i=0;i<bytes.length-8;i++)if(bytes[i]===0x15&&bytes[i+1]===0x49&&bytes[i+2]===0xa9&&bytes[i+3]===0x66){
     const pos=i+4;if((bytes[pos]&0x80)===0)throw Error('unexpected WebM Info size');const n=bytes[pos]&127;if(n+11>126)throw Error('large Info');
     const dur=new Uint8Array(11);dur.set([0x44,0x89,0x88]);new DataView(dur.buffer).setFloat64(3,2200,false);
     const next=new Uint8Array(bytes.length+11);next.set(bytes.slice(0,pos+n+1));next[pos]=0x80|(n+11);next.set(dur,pos+n+1);next.set(bytes.slice(pos+n+1),pos+n+12);bytes=next;break;
    }
    window.__videoURL=URL.createObjectURL(new Blob([bytes],{type:'video/webm'}));
    window.__writes=[];window.__comments=[{id:1,artifact_id:'${HEX}',parent_id:null,anchor:{whole:true},at_s:0,body:'Check the opening',author:{kind:'owner',name:'You',subject:'owner'},can:{reply:true,edit:true,delete:true,resolve:true}},{id:2,artifact_id:'${OLD}',from_version:1,carried:'found',parent_id:null,anchor:{whole:true},at_s:1.2,end_s:1.7,body:'Earlier cut: shorten this shot',author:{kind:'owner',name:'You',subject:'owner'},can:{reply:true,edit:true,delete:true,resolve:true}}];
    const real=window.fetch;const json=o=>new Response(JSON.stringify(o),{headers:{'Content-Type':'application/json'}});
    window.fetch=async(u,o={})=>{const url=String(u),method=o.method||'GET';
     if(/\\/api\\/artifacts\\/[89]{64}\\/comments/.test(url)){
      if(method==='GET')return json({comments:window.__comments,you:{can_comment:true,can_lock:true},locked:false});
      const body=o.body?JSON.parse(o.body):null;window.__writes.push({url,method,body});
      const m=url.match(/comments\\/(\\d+)\\/(resolve|reopen|send)/);
      if(m){const c=window.__comments.find(c=>c.id===+m[1]);if(m[2]==='send')return json({ok:true,results:[{agent:'Dev',state:'sent'}]});c.resolved_at=m[2]==='resolve'?new Date().toISOString():null;return json(c);}
      const c={...window.__comments[0],...body,id:window.__comments.length+1,artifact_id:'${HEX}'};window.__comments.push(c);return json(c);
     }
     if(url.includes('/api/board/team-a/status'))return json({agents:[{role:'Dev',name:'Dev',agent_type:'codex',availability:'ready'}]});
     if(url.includes('/api/artifacts/${HEX}')){const r=new Response(bytes,{headers:{'Content-Type':'video/webm'}});Object.defineProperty(r,'url',{value:window.__videoURL});return r;}
     return real(u,o);
    };
    const v=await import((window.__coralStatic||'/static/')+'artifact_viewer.js');v.openArtifactViewer('${HEX}',{filename:'review.webm',mediaType:'video/webm',board:'team-a',server:${cloud?"'video-remote'":"undefined"}});
   })()`);
   await waitFor(`!!document.querySelector('#artifact-viewer video')`,'video');
   await shot(`video-before-${config.width}-${config.theme}`);
   await waitFor(`!!document.querySelector('.avc-track') && document.querySelectorAll('.avc-dot').length===2`,'timeline and comments');
   await waitFor(`Number.isFinite(document.querySelector('#artifact-viewer video').duration)`,'real video metadata');
   assert.equal(await ev(`document.querySelector('.avc-dot').getAttribute('aria-label').startsWith('00:00')`),true);
   await ev(`document.querySelector('.avc-dot[data-id="2"]').click()`);
   await waitFor(`Math.abs(document.querySelector('#artifact-viewer video').currentTime-1.2)<0.15`,'dot seek');
   assert.equal(await ev(`document.querySelector('.ac-video-time').textContent`),'00:00');
   if(!cloud){
    await ev(`document.querySelector('.avc-comment').click();document.querySelector('.ac-input').value='Shorten the pause';document.querySelector('.ac-composer').requestSubmit()`);
    await waitFor(`window.__writes.some(w=>w.method==='POST'&&w.body?.at_s!=null)`,'timed comment');
    assert.equal(await ev(`window.__writes.find(w=>w.body?.at_s!=null).body.notify_agent`),false);
    await ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-open').click()`);
    await waitFor(`!!document.querySelector('.ac-ask input[type="checkbox"]')`,'send picker');
    await ev(`document.querySelector('.ac-ask input[type="checkbox"]').click();document.querySelector('.ac-ask-go').click()`);
    await waitFor(`window.__writes.some(w=>w.url.endsWith('/comments/1/send'))`,'manual send uses the thread endpoint');
    await ev(`document.querySelector('.ac-ask .ac-cancel').click()`);
    await ev(`document.querySelector('.ac-card[data-id="1"] .ac-resolve').click()`);
    await waitFor(`!document.querySelector('.ac-card[data-id="1"]')`,'resolved hidden');
    await ev(`document.querySelector('.ac-showresolved').click()`);
    await ev(`document.querySelector('.ac-card[data-id="1"] .ac-resolve').click()`);
    await waitFor(`!window.__comments[0].resolved_at`,'reopened');
    const r=await ev(`(()=>{const r=document.querySelector('.avc-track').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width}})()`);
    await Input.dispatchMouseEvent({type:'mousePressed',x:r.x+r.w*.2,y:r.y+10,button:'left',clickCount:1});
    await Input.dispatchMouseEvent({type:'mouseMoved',x:r.x+r.w*.7,y:r.y+10,buttons:1});
    await Input.dispatchMouseEvent({type:'mouseReleased',x:r.x+r.w*.7,y:r.y+10,button:'left',clickCount:1});
    await ev(`document.querySelector('.avc-comment').click();document.querySelector('.ac-input').value='This stretch';document.querySelector('.ac-composer').requestSubmit()`);
    await waitFor(`window.__writes.some(w=>w.body?.end_s>w.body?.at_s)`,'dragged range posted');
    await ev(`window.__sendStart=window.__writes.length;document.querySelector('.ac-send-open').click()`);
    await waitFor(`!!document.querySelector('.ac-ask input[type="checkbox"]')`,'bulk send picker');
    await ev(`document.querySelector('.ac-ask input[type="checkbox"]').click();document.querySelector('.ac-ask-go').click()`);
    await waitFor(`window.__writes.slice(window.__sendStart).filter(w=>w.url.endsWith('/send')).length===window.__comments.length`,'all open comments sent sequentially');
    assert.equal(await ev(`(()=>{const sent=window.__writes.slice(window.__sendStart).filter(w=>w.url.endsWith('/send'));const expected=[...window.__comments].sort((a,b)=>a.at_s-b.at_s);return sent.every((w,i)=>w.url.includes('/'+expected[i].artifact_id+'/comments/'+expected[i].id+'/send'));})()`),true,'bulk sends in time order using each original artifact');
    await ev(`document.querySelector('.ac-ask .ac-cancel').click();document.querySelector('.avc-track').focus()`);
    await Input.dispatchKeyEvent({type:'keyDown',key:' ',code:'Space'});await Input.dispatchKeyEvent({type:'keyUp',key:' ',code:'Space'});
    await waitFor(`!document.querySelector('#artifact-viewer video').paused`,'keyboard plays real video');
    await ev(`document.querySelector('#artifact-viewer video').pause()`);
   } else {
    assert.equal(await ev(`document.querySelector('.avc-comment').hidden && !document.querySelector('.ac-whole') && !document.querySelector('.ac-resolve') && !document.querySelector('.ac-ask-open') && !document.querySelector('.ac-send-open')`),true,'Hub controls hidden');
    assert.equal(await ev(`window.__writes.length`),0);
   }
   assert.equal(await ev(`document.querySelector('#artifact-viewer').scrollWidth<=innerWidth+1`),true,'no horizontal overflow');
   await shot(`video-after-${config.width}-${config.theme}${config.zoom?'-200':''}${cloud?'-hub':''}`);
   console.log('[PASS] video review '+JSON.stringify(config));
   await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click()`);
  }
 }finally{await client.close();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
