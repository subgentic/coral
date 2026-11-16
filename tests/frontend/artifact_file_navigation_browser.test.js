// #15867: file arrows operate on the originating list, independently of version arrows.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
 const {client,Page,ev,waitFor,PRELOAD,install}=await connect();
 const { Input } = client;
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Page.navigate({url:BASE});await Page.loadEventFired();await install();await coralReady(ev);
  await ev(`(()=>{const real=window.fetch;window.fetch=(u,o)=>{const url=String(u.url||u);if(['a','b','c'].some(c=>url.includes('/api/artifacts/'+c.repeat(64))) && !url.includes('/comments') && !url.includes('/versions'))return Promise.resolve(new Response('# Navigation note\\n\\n'+url,{headers:{'Content-Type':'text/markdown'}}));return real(u,o)};return true;})()`);
  const context = await ev(`(async()=>{const {fileContext}=await import((window.__coralStatic||'/static/')+'artifact_file_context.js');const table=document.createElement('table');table.innerHTML='<tbody><tr data-key="second"><td></td></tr><tr data-key="first"><td></td></tr></tbody>';document.body.append(table);const items=[{id:'first',hex:'a'.repeat(64),server:'computer-a',board:'team-a'},{id:'second',hex:'b'.repeat(64),server:'computer-b',board:'team-b'},{id:'filtered',hex:'c'.repeat(64)}];const out=fileContext(items,items[1],{key:r=>r.id,options:r=>({...r}),opener:table.querySelector('td')});table.remove();return out;})()`);
  assert.equal(context.fileIndex,0,'display order determines current index');
  assert.deepEqual(context.fileList.map(x=>[x.id,x.server,x.board]),[['second','computer-b','team-b'],['first','computer-a','team-a']],'origin filter/order and independent computer/team metadata');
  await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m=>m.openArtifactViewer('b'.repeat(64),{filename:'second.md',fileIndex:1,fileList:['a','b','c'].map((c,i)=>({hex:c.repeat(64),filename:['first.md','second.md','third.md'][i],mediaType:'text/markdown'}))}))`);
  await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`,'initial file');
  assert.equal(await ev(`document.querySelector('.artifact-file-position')?.textContent`),'2 of 3','file position shown');
  const key=async key=>{await Input.dispatchKeyEvent({type:'keyDown',key});await Input.dispatchKeyEvent({type:'keyUp',key});};
  await ev(`document.querySelector('.artifact-viewer-close').focus();true`);await key('ArrowRight');
  await waitFor(`document.querySelector('.artifact-viewer-title').textContent.includes('third.md')`,'next file');
  assert.equal(await ev(`document.querySelector('.artifact-file-next').disabled`),true,'last file stops');
  await key('ArrowLeft');await waitFor(`document.querySelector('.artifact-viewer-title').textContent.includes('second.md')`,'previous file');
  await ev(`(()=>{const t=document.createElement('textarea');t.id='navigation-edit-probe';document.querySelector('#artifact-viewer .artifact-viewer-main').append(t);t.focus();return true})()`);await key('ArrowLeft');
  assert.ok(await ev(`document.querySelector('.artifact-viewer-title').textContent.includes('second.md')`),'typing does not navigate');
  await ev(`document.getElementById('navigation-edit-probe').remove();const s=getSelection(),r=document.createRange();r.selectNodeContents(document.querySelector('.artifact-viewer-markdown'));s.removeAllRanges();s.addRange(r);document.querySelector('.artifact-viewer-close').focus();true`);await key('ArrowLeft');
  assert.ok(await ev(`document.querySelector('.artifact-viewer-title').textContent.includes('second.md')`),'selected text does not navigate');
  await ev(`getSelection().removeAllRanges();true`);await key('ArrowDown');
  assert.ok(await ev(`document.querySelector('.artifact-viewer-title').textContent.includes('second.md')`),'Down does not change files');
  await ev(`document.querySelector('.artifact-file-prev').click();true`);await waitFor(`document.querySelector('.artifact-viewer-title').textContent.includes('first.md')`,'previous button');
  assert.equal(await ev(`document.querySelector('.artifact-file-prev').disabled`),true,'first file stops');
  await ev(`document.querySelector('.artifact-file-help').click();true`);
  assert.match(await ev(`document.querySelector('.artifact-file-help-text').textContent`),/Left.*Right/);
  if(process.env.CORAL_SCREENSHOT_DIR){require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});require('node:fs').writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/file-navigation.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
 }finally{await client.close()}
 console.log('PASS artifact file navigation, list bounds, typing/selection guards and keyboard help');
})().catch(e=>{console.error(e);process.exit(1)});
