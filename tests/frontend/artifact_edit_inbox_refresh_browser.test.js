// #13810: actual edit/save refreshes a loaded second Inbox page without losing its rows or scroll position.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { launchStandIn } = require('./helpers/stand_in_agent');
const { guardSettings } = require('./helpers/settings_guard');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const hexOf = data => String(data.digest || data.hex || data.id || '').replace(/^sha256:/,'');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard=await guardSettings();
    const B = 'editrows-' + Date.now().toString(36); let author;
    const httpJson = async (method, p, body, headers = {}) => { const r = await fetch(BASE+p,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))}; };
    const person = (method,p,body) => ev(`fetch(${JSON.stringify(p)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body===undefined?'undefined':JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json().catch(()=>({}))}))`);
    const upload = async (name, text, previous) => { const r=await fetch(BASE+`/api/agent/artifacts?session_id=${author.sid}`,{method:'POST',headers:{'X-Coral-Session-Token':author.token,'Content-Type':'application/octet-stream','X-Artifact-Name':name,'X-Artifact-Media-Type':'text/markdown',...(previous?{'X-Artifact-New-Version-Of':previous}:{})},body:Buffer.from(text)});const data=await r.json();assert.equal(r.status,201,JSON.stringify(data));return hexOf(data); };
    const bytes = hex => ev(`fetch('/api/artifacts/${hex}?v=2').then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))`);
    const nativeClick = async selector => { const r=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered '+${JSON.stringify(selector)}+' by '+document.elementFromPoint(x,y)?.outerHTML);return{x,y};})()`);await client.Input.dispatchMouseEvent({type:'mousePressed',...r,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',...r,button:'left',clickCount:1}); };
    const edit = async () => { if(await ev(`document.querySelector('.artifact-viewer-edit').getClientRects().length > 0`)) await nativeClick('.artifact-viewer-edit'); else { await nativeClick('.artifact-viewer-more'); await waitFor(`!document.querySelector('.artifact-viewer-menu').hidden`,'phone More actions',5000); await nativeClick('.artifact-viewer-edit-item'); } };
    const type = async (oldText,newText) => { await ev(`(()=>{const e=[...document.querySelectorAll('.amd-text')].find(e=>e.textContent===${JSON.stringify(oldText)});if(!e)throw Error('No editable words');e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);await client.Input.insertText({text:newText}); };
    const shot = async name => { const dir=process.env.CORAL_SCREENSHOT_DIR;if(!dir)return;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    const open = async (hex,name) => { await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(v=>v.openArtifactViewer('${hex}',{board:'${B}',server:'local',filename:${JSON.stringify(name)},mediaType:'text/markdown'}))`);await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`,'the real Markdown document',10000); };
    try {
        assert.ok(process.env.CORAL_TEST_DATA_DIR,'isolated runner only');
        await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
        await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','liveList','liveListLoaded','settings');
        await httpJson('POST',`/api/board/${B}/subscribe`,{subscriber_id:'Markdown Writer',job_title:'Writer'});
        author=await launchStandIn((method,p,body)=>httpJson(method,p,p==='/api/sessions/launch'?{...body,board_id:B}:body),{displayName:'Markdown Writer'});assert.ok(author.sid && author.token,'real stand-in agent token');
        const liveReply=await (await fetch(BASE+'/api/sessions/live')).json();const live=(Array.isArray(liveReply)?liveReply:liveReply.sessions||[]).find(s=>s.session_id===author.sid);assert.ok(live);
        assert.ok((await httpJson('POST',`/api/board/${B}/subscribe`,{subscriber_id:'Markdown Writer',job_title:'Writer',session_name:`${live.agent_type}-${author.sid}`})).status<300);


        const originals=[];
        for(let i=0;i<66;i++) originals.push(await upload(`${B}-inbox-report-${String(i).padStart(3,'0')}.md`,`# Report ${i}\n\nA **careful sentence** stays in report ${i}.\n`));
        await ev(`window.__pageLifetime='same-page';window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('artifacts'))`);
        await waitFor(`!!document.querySelector('.inbox-artifacts-list')`,'Inbox file list mounted',10000);
        // Other suites can leave legitimate files in the shared server: search this fixture's unique names.
        await ev(`import((window.__coralStatic||'/static/')+'inbox_artifacts.js').then(m=>m.setArtifactSearch('${B}-inbox-report-'))`);
        const rows='.inbox-artifacts-list [data-artifact-id]';
        await waitFor(`document.querySelectorAll('${rows}').length>=50`,'real first Inbox page',15000);
        if(await ev(`!!document.querySelector('.inbox-artifacts-list .dt-more')`))await nativeClick('.inbox-artifacts-list .dt-more');
        await waitFor(`document.querySelectorAll('${rows}').length===66`,'second page contains all 66 files',15000);
        // An older file beyond page one is edited. Native row/Open clicks follow the actual Inbox flow.
        const target=await ev(`(()=>{const rows=[...document.querySelectorAll('${rows}')];const row=rows[60];row.classList.add('edit-row-target');return{key:row.dataset.artifactId,name:row.textContent};})()`);
        await nativeClick('.edit-row-target');await waitFor(`!!document.querySelector('.inbox-detail-pane .btn-primary')`,'Open action in file details',8000);
        await ev(`window.__listScroller=()=>{let e=document.querySelector('.inbox-artifacts-list [data-artifact-id]');while(e&&!(e.scrollHeight>e.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)))e=e.parentElement;return e;};true`);
        const before=await ev(`({count:document.querySelectorAll('${rows}').length,top:window.__listScroller().scrollTop})`);assert.ok(before.top>500,'the real paginated list is scrolled');await shot('inbox-edit-paged-before');
        await nativeClick('.inbox-detail-pane .btn-primary');await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`,'Inbox opens stored Markdown',10000);
        await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'owner edit available',10000);await edit();await waitFor(`!!document.querySelector('.amd-text')`,'editor loaded',8000);await type('careful sentence','clear sentence');await nativeClick('.amd-save');
        await waitFor(`!document.querySelector('.amd-editor') && !!document.querySelector('.artifact-viewer-version')`,'new saved version opens',10000);
        const original=target.key.match(/[a-f0-9]{64}/)?.[0];assert.ok(original,JSON.stringify(target));
        const versions=(await person('GET',`/api/artifacts/${original}/versions`)).data;assert.equal(versions.length,2);const saved=hexOf(versions.find(v=>v.is_latest)||versions[versions.length-1]);
        await nativeClick('.artifact-viewer-close');
        await waitFor(`!![...document.querySelectorAll('${rows}')].find(r=>r.dataset.artifactId.includes('${saved}'))`,'Inbox row uses saved digest without a reload',10000);
        assert.equal(await ev(`window.__pageLifetime`),'same-page','the document was never reloaded');
        const after=await ev(`({count:document.querySelectorAll('${rows}').length,top:window.__listScroller().scrollTop,keys:[...document.querySelectorAll('${rows}')].map(r=>r.dataset.artifactId)})`);
        assert.equal(after.count,66,'saving must keep every already-loaded page');assert.equal(new Set(after.keys).size,66,'one row per immutable series, no duplicates');assert.ok(!after.keys.some(k=>k.includes(original)),'old digest is replaced by saved version');assert.ok(Math.abs(after.top-before.top)<2,`list place retained: ${before.top} -> ${after.top}`);
        await waitFor(`document.querySelector('.inbox-detail-pane')?.textContent.includes('A clear sentence')`,'returning detail pane shows the newly saved words',8000);
        assert.ok(!await ev(`document.querySelector('.inbox-detail-pane')?.textContent.includes('A careful sentence')`),'old preview is replaced');
        await shot('inbox-edit-paged-after');
        console.log('PASS real owner save: new digest replaces old Inbox row, all 66 loaded files and scroll position retained without reload');
    } finally { if(author)await author.stop().catch(()=>{});await removeBoards(ev,[B]);await guard.restore();await client.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
