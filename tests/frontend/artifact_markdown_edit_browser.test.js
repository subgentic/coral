// Real artifact bytes + real person-only version route on the isolated server. No save stubs.
// Native typing saves one sentence, keeps BOM/CRLF/marks, and the existing version diff
// shows one changed line. A newer agent upload produces 409; only an explicit choice retries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { launchStandIn } = require('./helpers/stand_in_agent');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady, waitStable, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const hexOf = data => String(data.digest || data.hex || data.id || '').replace(/^sha256:/,'');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'mdedit-' + Date.now().toString(36); let author;
    const httpJson = async (method, p, body, headers = {}) => { const r = await fetch(BASE+p,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))}; };
    const person = (method,p,body) => ev(`fetch(${JSON.stringify(p)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body===undefined?'undefined':JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json().catch(()=>({}))}))`);
    const upload = async (name, text, previous) => { const r=await fetch(BASE+`/api/agent/artifacts?session_id=${author.sid}`,{method:'POST',headers:{'X-Coral-Session-Token':author.token,'Content-Type':'application/octet-stream','X-Artifact-Name':name,'X-Artifact-Media-Type':'text/markdown',...(previous?{'X-Artifact-New-Version-Of':previous}:{})},body:Buffer.from(text)});const data=await r.json();assert.equal(r.status,201,JSON.stringify(data));return hexOf(data); };
    const bytes = hex => ev(`fetch('/api/artifacts/${hex}?v=2').then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))`);
    const nativeClick = async selector => {
        // Scroll only an off-target control, then wait on its enabled, stable geometry.
        await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))e.scrollIntoView({block:'nearest',inline:'nearest'});})()`);
        await waitStable(ev, `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,disabled:!!e.disabled};})()`, selector+' enabled stable rectangle', 40, {timeout:5000,accept:r=>!r.disabled&&r.w>0&&r.h>0});
        const r=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),b=e.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered '+${JSON.stringify(selector)}+' by '+document.elementFromPoint(x,y)?.outerHTML);return{x,y};})()`);
        // The controlled late response lands after measurement in the old helper.
        if (selector === '.artifact-viewer-edit-item' && await ev(`!!window.__mdVersionGate?.release`)) {
            await ev(`window.__mdVersionGate.release();window.__mdVersionGate.release=null;true`);
            await waitFor(`!!document.querySelector('.av-current')`, 'injected version chip lands', 8000);
            await ev(framesJs(2));
            const moved=await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};})()`);
            console.log('CONTROLLED VERSION RESPONSE: measured',JSON.stringify(r),'after chip',JSON.stringify(moved));
        }
        await client.Input.dispatchMouseEvent({type:'mousePressed',...r,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',...r,button:'left',clickCount:1}); };
    const edit = async () => { if(await ev(`document.querySelector('.artifact-viewer-edit').getClientRects().length > 0`)) await nativeClick('.artifact-viewer-edit'); else { await nativeClick('.artifact-viewer-more'); await waitFor(`!document.querySelector('.artifact-viewer-menu').hidden`,'phone More actions',5000); await nativeClick('.artifact-viewer-edit-item'); } };
    const type = async (oldText,newText) => { await ev(`(()=>{const e=[...document.querySelectorAll('.amd-text')].find(e=>e.textContent===${JSON.stringify(oldText)});if(!e)throw Error('No editable words');e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);await client.Input.insertText({text:newText}); };
    const shot = async name => { const dir=process.env.CORAL_SCREENSHOT_DIR;if(!dir)return;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    const open = async (hex,name,version=0) => { await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(v=>v.openArtifactViewer('${hex}',{board:'${B}',server:'local',filename:${JSON.stringify(name)},mediaType:'text/markdown'}))`);await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`,'the real Markdown document',10000);
        if(version) {
            // A cold versions read can add a header row and move the phone menu.
            // Release the real response before hit-testing; the mutation proof removes this readiness block.
            if(await ev(`!!window.__mdVersionGate`)) {
                await waitFor(`!!window.__mdVersionGate.release`,'real versions response is held',8000);
                await ev(`window.__mdVersionGate.release();window.__mdVersionGate.release=null;true`);
            }
            await waitFor(`document.querySelector('.av-current')?.getAttribute('aria-label')?.startsWith('Version: v${version} of ')`,'version header ready before Edit',8000);
            await ev(`delete window.__mdVersionGate;true`);
        }
    };
    try {
        assert.ok(process.env.CORAL_TEST_DATA_DIR,'isolated runner only');
        await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
        await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','liveList','liveListLoaded','settings');
        author=await launchStandIn(httpJson,{displayName:'Markdown Writer'});assert.ok(author.sid && author.token,'real stand-in agent token');
        const liveReply=await (await fetch(BASE+'/api/sessions/live')).json();const live=(Array.isArray(liveReply)?liveReply:liveReply.sessions||[]).find(s=>s.session_id===author.sid);assert.ok(live);
        assert.ok((await httpJson('POST',`/api/board/${B}/subscribe`,{subscriber_id:'Markdown Writer',job_title:'Writer',session_name:`${live.agent_type}-${author.sid}`})).status<300);
        for (const [w,theme,font,reference] of [[1280,'dark',16],[390,'light',16],[390,'dark',32],[1280,'dark',16,true]]) {
            await Emulation.setDeviceMetricsOverride({width:w,height:900,deviceScaleFactor:1,mobile:w===390});
            await ev(`localStorage.setItem('coral-theme','${theme}');document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${font}px';true`);
            const name=`real-report-${w}-${font}${reference?'-reference':''}.md`, body=`\ufeff# Real agent report ${w}/${font}\r\n\r\nA **careful sentence** stays in this report.\r\n\r\nUnchanged second line.\r\n\r\n- Keep this list marker.\r\n\r\n\x60\x60\x60js\r\nconst unchanged = true;\r\n\x60\x60\x60\r\n\r\nHidden\u202e content stays byte-identical.\r\n`;
            // The omitted definition repeats visible heading/paragraph raw text; it must stay byte-identical.
            const prefix=reference?`[source]: https://example.com/ "\r\n# Real agent report ${w}/${font}\r\nA **careful sentence** stays in this report.\r\n"\r\n\r\n`:'';
            const source=body[0]+prefix+body.slice(1);
            const original=await upload(name,source);assert.match(original,/^[a-f0-9]{64}$/);
            await open(original,name);await shot(`markdown-edit-before-${w}-${font}${reference?'-reference':''}`);
            await waitFor(`!!document.querySelector('.artifact-viewer-edit') && !document.querySelector('.artifact-viewer-edit').hidden`,'owner Edit text action',12000);
            await edit();await waitFor(`!!document.querySelector('.amd-text')`,'in-place editor',10000,`({body:document.querySelector('.artifact-viewer-body')?.textContent,menu:document.querySelector('.artifact-viewer-menu')?.outerHTML,edit:document.querySelector('.artifact-viewer-edit')?.outerHTML,items:[...document.querySelectorAll('.artifact-viewer-edit-item')].map(e=>({html:e.outerHTML,rect:e.getBoundingClientRect().toJSON(),display:getComputedStyle(e).display}))})`);
            assert.ok(await ev(`document.querySelector('.amd-editor').textContent.includes('U+202E')`),'hidden marker is visible in editing mode');
            assert.equal(await ev(`document.querySelectorAll('.amd-block pre [contenteditable],.amd-block table [contenteditable]').length`),0);
            await type('careful sentence','clear sentence');
            assert.equal(await ev(`document.querySelector('.amd-save').disabled`),false,'Save enables before blur');
            assert.ok(await ev(`document.querySelector('.amd-editor').scrollWidth <= document.querySelector('.amd-editor').clientWidth + 1`),'editor fits without horizontal overflow');
            if(w===390) assert.ok(await ev(`[...document.querySelectorAll('.artifact-viewer-foot .amd-save,.artifact-viewer-foot .amd-cancel')].every(e=>e.getBoundingClientRect().height>=44)`),'phone save/cancel targets are at least 44px');
            await shot(`markdown-edit-draft-${w}-${font}${reference?'-reference':''}`);
            await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor') && !!document.querySelector('.artifact-viewer-version')`,'saved version opens',12000,`({status:document.querySelector('.amd-status')?.textContent,dirty:document.querySelector('.amd-save')?.disabled,body:document.querySelector('.artifact-viewer-body')?.textContent,title:document.querySelector('.artifact-viewer-title')?.textContent})`);
            const versions=(await person('GET',`/api/artifacts/${original}/versions`)).data;assert.ok(Array.isArray(versions));assert.equal(versions.length,2);
            const saved=versions.find(v=>v.is_latest || v.isLatest) || versions[versions.length-1];const savedHex=hexOf(saved), expected=body[0]+prefix+body.slice(1).replace('careful sentence','clear sentence');
            assert.deepEqual(Buffer.from(await bytes(savedHex)),Buffer.from(expected),'saved bytes differ only in the intended words, including BOM/CRLF');
            assert.deepEqual(Buffer.from(await bytes(original)),Buffer.from(source),'original artifact is immutable');
            await waitFor(`!!document.querySelector('#artifact-viewer button.av-compare')`,'compare the stored versions',8000);await nativeClick('#artifact-viewer button.av-current');await nativeClick('#artifact-viewer button.av-compare');await waitFor(`!!document.querySelector('.av-count')`,'real version diff',8000);
            assert.equal(await ev(`document.querySelector('.av-count').textContent`),'1 added, 1 removed');
            assert.deepEqual(await ev(`[...document.querySelectorAll('.av-add ins,.av-del del')].map(e=>e.textContent)`),['A **careful sentence** stays in this report.\r','A **clear sentence** stays in this report.\r']);
            await shot(`markdown-edit-saved-diff-${w}-${font}${reference?'-reference':''}`);
            // Return to the stored file, then verify a newer agent version cannot be overwritten.
            if(w===390 && font===32) {
                // Force a genuinely cold read on the already-saved file. The response bytes are untouched.
                await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','liveList','liveListLoaded','settings');
                await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${font}px';(()=>{const real=window.fetch,gate=window.__mdVersionGate={};window.fetch=async(u,o)=>{const r=await real(u,o);if(new URL(String(u),location.href).pathname==='/api/artifacts/${savedHex}/versions'&&!gate.used){gate.used=true;await new Promise(resolve=>gate.release=resolve);}return r;};})()`);
            }
            await open(savedHex,name,2);await waitFor(`!!document.querySelector('.artifact-viewer-edit') && !document.querySelector('.artifact-viewer-edit').hidden`,'Edit saved version',8000);await edit();await waitFor(`!!document.querySelector('.amd-text')`,'edit before conflict',8000);
            await type('clear sentence','my sentence');await ev(`document.activeElement.blur()`);
            const theirs=expected.replace('Unchanged second line.','Another agent changed this line.');const newer=await upload(name,theirs,savedHex);
            await nativeClick('.amd-save');await waitFor(`!!document.querySelector('.amd-reapply,.amd-save-after')`,'server-side 409 keeps the draft',10000);
            assert.ok(await ev(`document.querySelector('.amd-document').textContent.includes('my sentence')`));
            await nativeClick('.amd-see-theirs');await waitFor(`!!document.querySelector('.amd-theirs')`,'See theirs',8000);assert.ok(await ev(`document.querySelector('.amd-theirs').textContent.includes('Another agent changed this line.')`));
            await nativeClick('.amd-reapply,.amd-save-after');await waitFor(`!document.querySelector('.amd-editor')`,'edits reapplied on the newest version',10000);
            assert.deepEqual(Buffer.from(await bytes(newer)),Buffer.from(theirs),'the concurrent version remains unchanged');
            const latestList=(await person('GET',`/api/artifacts/${original}/versions`)).data;assert.equal(latestList.length,4);let final=latestList.find(v=>v.is_latest)||latestList[latestList.length-1];assert.deepEqual(Buffer.from(await bytes(hexOf(final))),Buffer.from(theirs.replace('clear sentence','my sentence')),'reapply retains the agent change in the other block');
            // A changed edited block must never be overwritten: no second POST until the person redoes it on latest.
            const merged=theirs.replace('clear sentence','my sentence');
            await open(hexOf(final),name,final.version);await waitFor(`!!document.querySelector('.artifact-viewer-edit') && !document.querySelector('.artifact-viewer-edit').hidden`,'Edit for same-block conflict',8000);await edit();await waitFor(`!!document.querySelector('.amd-text')`,'same-block editor',8000);await type('my sentence','my unsaved sentence');await ev(`document.activeElement.blur()`);
            const changedBlock=merged.replace('my sentence','agent sentence'), changedHex=await upload(name,changedBlock,hexOf(final));
            await nativeClick('.amd-save');await waitFor(`!!document.querySelector('.amd-reapply,.amd-save-after')`,'same-block 409',8000);await nativeClick('.amd-reapply,.amd-save-after');
            await waitFor(`!!document.querySelector('.amd-kept:not([hidden])')`,'changed block keeps the draft and opens latest for redo',8000);
            assert.ok(await ev(`document.querySelector('.amd-kept').textContent.includes('my unsaved sentence')`));assert.ok(await ev(`document.querySelector('.amd-document').textContent.includes('agent sentence')`));assert.equal(await ev(`document.querySelector('.amd-save').disabled`),true);
            assert.equal((await person('GET',`/api/artifacts/${original}/versions`)).data.length,5,'same-block conflict creates no version');assert.deepEqual(Buffer.from(await bytes(changedHex)),Buffer.from(changedBlock));
            await shot(`markdown-edit-conflict-${w}-${font}${reference?'-reference':''}`);
            await ev(`document.querySelector('.amd-kept').scrollIntoView({block:'start'});true`);await shot(`markdown-edit-kept-${w}-${font}${reference?'-reference':''}`);
            await nativeClick('.amd-cancel');await waitFor(`!!document.querySelector('.amd-discard[open]')`,'kept draft is guarded before any redo',5000);await nativeClick('.amd-discard .btn:not(.btn-danger)');await waitFor(`!document.querySelector('.amd-discard')`,'continue the redo with draft kept',5000);

            await type('agent sentence','redone sentence');await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor')`,'explicit redo saved on latest',10000);
            const redoneList=(await person('GET',`/api/artifacts/${original}/versions`)).data;assert.equal(redoneList.length,6);final=redoneList.find(v=>v.is_latest)||redoneList[redoneList.length-1];assert.deepEqual(Buffer.from(await bytes(hexOf(final))),Buffer.from(changedBlock.replace('agent sentence','redone sentence')),'manual redo preserves other agent blocks');
            // Agent token is rejected by the real owner write route, even with a correct expected digest.
            const refused=await fetch(BASE+`/api/board/${B}/artifacts/${original}/edit?expected_latest=${hexOf(final)}`,{method:'POST',headers:{'X-Coral-Session-Token':author.token,'Content-Type':'text/markdown',Origin:BASE},body:Buffer.from('no permission')});assert.equal(refused.status,403);
            // Cancel and Escape must not silently discard a draft.
            await open(hexOf(final),name,final.version);await waitFor(`!!document.querySelector('.artifact-viewer-edit') && !document.querySelector('.artifact-viewer-edit').hidden`,'Edit for guard',8000);await edit();await waitFor(`!!document.querySelector('.amd-text')`,'guard editor',8000);await type('redone sentence','unsaved sentence');
            await ev(`document.querySelector('.amd-save').focus()`);await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await client.Input.dispatchKeyEvent({type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await waitFor(`!!document.querySelector('.amd-discard[open]')`,'discard prompt',5000);await nativeClick('.amd-discard .btn:not(.btn-danger)');await waitFor(`!document.querySelector('.amd-discard')`,'Keep editing closes only the prompt',5000);assert.ok(await ev(`document.querySelector('.amd-document').textContent.includes('unsaved sentence')`));
            await nativeClick('.amd-cancel');await waitFor(`!!document.querySelector('.amd-discard[open]')`,'Cancel asks before discarding',5000);await nativeClick('.amd-discard .btn-danger');await waitFor(`!document.querySelector('.amd-editor')`,'discard only after confirmation',5000);await nativeClick('.artifact-viewer-close');
            console.log(`PASS real save/byte diff, conflict, safe reapply, same-block refusal/redo, agent refusal and discard guard ${w}px ${theme} ${font}px${reference?' with repeated reference definition':''}`);
        }
    } finally { if(author)await author.stop().catch(()=>{});await removeBoards(ev,[B]);await client.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
