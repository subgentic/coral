// Real artifact bytes + real person-only version route on the isolated server. No save stubs.
// Native typing saves one sentence, keeps BOM/CRLF/marks, and the existing version diff
// shows one changed line. A newer agent upload produces 409; only an explicit choice retries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { launchStandIn } = require('./helpers/stand_in_agent');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady, waitStable } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const hexOf = data => String(data.digest || data.hex || data.id || '').replace(/^sha256:/,'');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'mdmodes-' + Date.now().toString(36); let author;
    const httpJson = async (method, p, body, headers = {}) => { const r = await fetch(BASE+p,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))}; };
    const person = (method,p,body) => ev(`fetch(${JSON.stringify(p)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body===undefined?'undefined':JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json().catch(()=>({}))}))`);
    const upload = async (name, text, previous) => { const r=await fetch(BASE+`/api/agent/artifacts?session_id=${author.sid}`,{method:'POST',headers:{'X-Coral-Session-Token':author.token,'Content-Type':'application/octet-stream','X-Artifact-Name':name,'X-Artifact-Media-Type':'text/markdown',...(previous?{'X-Artifact-New-Version-Of':previous}:{})},body:Buffer.from(text)});const data=await r.json();assert.equal(r.status,201,JSON.stringify(data));return hexOf(data); };
    const bytes = hex => ev(`fetch('/api/artifacts/${hex}?v=2').then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))`);
    const nativeClick = async selector => {
        // Scroll only an off-target control, then wait on its enabled, stable geometry.
        await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))e.scrollIntoView({block:'nearest',inline:'nearest'});})()`);
        await waitStable(ev, `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,disabled:!!e.disabled};})()`, selector+' enabled stable rectangle', 40, {timeout:5000,accept:r=>!r.disabled&&r.w>0&&r.h>0});
        const r=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),b=e.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered '+${JSON.stringify(selector)}+' by '+document.elementFromPoint(x,y)?.outerHTML);return{x,y};})()`);
        await client.Input.dispatchMouseEvent({type:'mousePressed',...r,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',...r,button:'left',clickCount:1}); };
    const edit = async () => { if(await ev(`document.querySelector('.artifact-viewer-edit').getClientRects().length > 0`)) await nativeClick('.artifact-viewer-edit'); else { await nativeClick('.artifact-viewer-more'); await waitFor(`!document.querySelector('.artifact-viewer-menu').hidden`,'phone More actions',5000); await nativeClick('.artifact-viewer-edit-item'); } };
    const type = async (oldText,newText) => { await ev(`(()=>{const e=[...document.querySelectorAll('.amd-text')].find(e=>e.textContent===${JSON.stringify(oldText)});if(!e)throw Error('No editable words');e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);await client.Input.insertText({text:newText}); };
    const shot = async name => { if(name.startsWith('raw-'))await waitStable(ev,`[...document.querySelectorAll('.amd-modes .btn')].map(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}))`,'mode button colors settled',40,{timeout:5000});const dir=process.env.CORAL_SCREENSHOT_DIR;if(!dir)return;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    const open = async (hex,name,version=0) => { await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(v=>v.openArtifactViewer('${hex}',{board:'${B}',server:'local',filename:${JSON.stringify(name)},mediaType:'text/markdown'}))`);await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`,'the real Markdown document',10000);
        if(version) {
            await waitFor(`document.querySelector('.av-current')?.getAttribute('aria-label')?.startsWith('Version: v${version} of ')`,'version header ready before Edit',8000);
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

        for(const [w,theme,font] of [[1280,'dark',16],[390,'light',32]]) {
            await Emulation.setDeviceMetricsOverride({width:w,height:900,deviceScaleFactor:1,mobile:w===390});
            await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${font}px';true`);
            const name=`nested-list-${w}.md`,source=`\ufeff# Lists ${w}\r\n\r\n- Parent words\r\n  - Nested words\r\n    Continued words\r\n- Last words\r\n\r\nUnchanged tail.\r\n`;
            const original=await upload(name,source);await open(original,name);await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'owner edit ready',10000);await shot(`lists-before-${w}`);await edit();await waitFor(`!!document.querySelector('.amd-text')`,'rendered editor',8000);await shot(`lists-edit-${w}`);
            await type('Nested words\nContinued words','Revised nested\nContinued words');await ev(`document.activeElement.blur()`);
            assert.equal(await ev(`document.querySelectorAll('.amd-document li').length`),3);assert.equal(await ev(`document.querySelectorAll('.amd-document li .amd-text').length`),3);
            await type('Revised nested\nContinued words','Revised nested\nContinued words');
            await ev(`(()=>{const s=getSelection();s.collapseToEnd();})()`);await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await client.Input.insertText({text:'- literal'});await ev(`document.activeElement.blur()`);
            await shot(`lists-draft-${w}`);await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor') && !!document.querySelector('.artifact-viewer-version')`,'new list version',10000);
            let versions=(await person('GET',`/api/artifacts/${original}/versions`)).data;assert.equal(versions.length,2);let saved=versions.find(v=>v.is_latest)||versions.at(-1),hex=hexOf(saved);
            const expected=source.replace('Nested words\r\n    Continued words','Revised nested\r\n    Continued words\r\n    \\- literal');assert.equal(Buffer.from(await bytes(hex)).toString(),expected,'BOM/CRLF, markers and all untouched bytes retained');assert.deepEqual(Buffer.from(await bytes(original)),Buffer.from(source));
            await open(hex,name,2);await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'edit saved list',8000);await edit();await waitFor(`!!document.querySelector('.amd-text')`,'saved list editor',8000);await type('Parent words','My unsaved parent');await ev(`document.activeElement.blur()`);
            const theirs=expected.replace('Unchanged tail.','Agent updated tail.');const latestHex=await upload(name,theirs,hex);await nativeClick('.amd-save');await waitFor(`!!document.querySelector('.amd-open-latest')`,'stale save refused',10000);
            assert.equal((await person('GET',`/api/artifacts/${original}/versions`)).data.length,3,'stale draft makes no version');assert.equal(await ev(`!!document.querySelector('.amd-reapply,.amd-save-after')`),false);
            await nativeClick('.amd-open-latest');await waitFor(`!!document.querySelector('.amd-kept:not([hidden])')`,'draft kept for manual redo',8000);assert.equal((await person('GET',`/api/artifacts/${original}/versions`)).data.length,3,'opening latest never saves');assert.deepEqual(Buffer.from(await bytes(latestHex)),Buffer.from(theirs));
            assert.ok(await ev(`document.querySelector('.amd-kept').textContent.includes('My unsaved parent')`));assert.equal(await ev(`document.querySelector('.amd-save').disabled`),true);
            await shot(`lists-stale-${w}`);await nativeClick('.amd-cancel');await waitFor(`!!document.querySelector('.amd-discard[open]')`,'old draft guarded',5000);await nativeClick('.amd-discard .btn-danger');await waitFor(`!document.querySelector('.amd-editor')`,'discard explicit',5000);await nativeClick('.artifact-viewer-close');
            console.log(`PASS nested/continued lists, literal continuation, exact saved bytes and no stale auto-save ${w}px ${font}px`);
            const tableName=`table-${w}.md`,tableSource=`\ufeff# Tables ${w}\r\n\r\n| Item | Owner |\r\n|:---|---:|\r\n| Report | Operator |\r\n| Code | \x60a\\|b\x60 |\r\n`;
            const tableHex=await upload(tableName,tableSource);await open(tableHex,tableName);await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'table edit capability',8000);await shot(`tables-before-${w}`);await edit();await waitFor(`!!document.querySelector('.amd-document table .amd-text')`,'mapped table cells',8000);
            assert.equal(await ev(`getComputedStyle(document.querySelector('.amd-document td')).borderTopWidth`),'1px','shared content table borders remain in the editor');await type('Operator','New | Owner');await ev(`document.activeElement.blur()`);await type('a|b','a|b|c');await ev(`document.activeElement.blur()`);
            assert.equal(await ev(`document.querySelectorAll('.amd-document td').length`),4);assert.equal(await ev(`document.querySelectorAll('.amd-document tr').length`),3);await shot(`tables-draft-${w}`);await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor') && !!document.querySelector('.artifact-viewer-version')`,'table version saved',10000);
            const tableVersions=(await person('GET',`/api/artifacts/${tableHex}/versions`)).data;assert.equal(tableVersions.length,2);const tableSaved=hexOf(tableVersions.find(v=>v.is_latest)||tableVersions.at(-1));
            const tableExpected=tableSource.replace('Operator','New \\| Owner').replace('`a\\|b`','`a\\|b\\|c`');assert.equal(Buffer.from(await bytes(tableSaved)).toString(),tableExpected,'table edits keep bars, alignment, code delimiters and untouched bytes');assert.equal(await ev(`document.querySelectorAll('.artifact-viewer-markdown td').length`),4);await shot(`tables-saved-${w}`);await nativeClick('.artifact-viewer-close');
            console.log(`PASS table cell/code pipes, fixed shape and exact saved bytes ${w}px ${font}px`);
            const codeName=`code-${w}.md`,codeSource=`\ufeff# Code ${w}\r\n\r\n\x60\x60\x60bash\r\nprintf old\r\n\x60\x60\x60\r\n`;
            const codeHex=await upload(codeName,codeSource);await open(codeHex,codeName);await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'code edit capability',8000);await shot(`code-before-${w}`);await edit();await waitFor(`!!document.querySelector('.amd-document pre .amd-text')`,'mapped code body',8000);
            await type('printf old','printf new\n<b>literal</b>');await ev(`document.activeElement.blur()`);assert.equal(await ev(`document.querySelectorAll('.amd-document pre').length`),1);assert.equal(await ev(`!!document.querySelector('.amd-document b')`),false);await shot(`code-draft-${w}`);await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor') && !!document.querySelector('.artifact-viewer-version')`,'code version saved',10000);
            const codeVersions=(await person('GET',`/api/artifacts/${codeHex}/versions`)).data;assert.equal(codeVersions.length,2);const codeSaved=hexOf(codeVersions.find(v=>v.is_latest)||codeVersions.at(-1));assert.equal(Buffer.from(await bytes(codeSaved)).toString(),codeSource.replace('printf old','printf new\r\n<b>literal</b>'));await shot(`code-saved-${w}`);await nativeClick('.artifact-viewer-close');
            console.log(`PASS literal fenced code and exact saved bytes ${w}px ${font}px`);
            const quoteName=`quote-${w}.md`,quoteSource=`\ufeff# Quote ${w}\r\n\r\n> Quoted words\r\n>\r\n> > Nested quote\r\n\r\nOutside.\r\n`;
            const quoteHex=await upload(quoteName,quoteSource);await open(quoteHex,quoteName);await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'quote edit capability',8000);await shot(`quotes-before-${w}`);await edit();await waitFor(`!!document.querySelector('.amd-document blockquote .amd-text')`,'mapped quote words',8000);
            await type('Nested quote','Revised quote\n> literal');await ev(`document.activeElement.blur()`);assert.equal(await ev(`document.querySelectorAll('.amd-document blockquote').length`),2);await shot(`quotes-draft-${w}`);await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor') && !!document.querySelector('.artifact-viewer-version')`,'quote version saved',10000);
            const quoteVersions=(await person('GET',`/api/artifacts/${quoteHex}/versions`)).data;assert.equal(quoteVersions.length,2);const quoteSaved=hexOf(quoteVersions.find(v=>v.is_latest)||quoteVersions.at(-1));assert.equal(Buffer.from(await bytes(quoteSaved)).toString(),quoteSource.replace('Nested quote','Revised quote\r\n> > \\> literal'));await shot(`quotes-saved-${w}`);await nativeClick('.artifact-viewer-close');
            console.log(`PASS quoted continuation, fixed nesting and exact saved bytes ${w}px ${font}px`);
            const rawName=`raw-${w}.md`,rawSource=`\ufeff# Raw ${w}\r\n\r\nOld words.\r\n`;
            const rawHex=await upload(rawName,rawSource);await open(rawHex,rawName);await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'raw edit capability',8000);await edit();await waitFor(`!!document.querySelector('.amd-mode-raw')`,'editor mode controls ready',8000);await nativeClick('.amd-mode-raw');await waitFor(`!!document.querySelector('.amd-raw')`,'whole file source',5000);await shot(`raw-before-${w}`);
            const rawPayload='<script>window.RAW_BAD=1</script>\n[bad](javascript:alert(1))\n![remote](https://example.com/blocked.png)\n[local](coral://artifacts/'+rawHex+')\n## New structure\nNew words.';
            await ev(`document.querySelector('.amd-raw').focus();document.querySelector('.amd-raw').select();true`);await client.Input.insertText({text:`# Raw ${w}\n\n`+rawPayload+'\n'});await nativeClick('.amd-preview-toggle');
            assert.equal(await ev(`!!document.querySelector('.amd-preview script,.amd-preview [href^="javascript:"],.amd-preview img[src^="https:"]')`),false);assert.equal(await ev(`!!document.querySelector('.amd-preview [href^="coral:"]')`),true);assert.equal(await ev(`window.RAW_BAD`),undefined);await ev(`document.querySelector('.amd-preview').scrollIntoView({block:'start'});true`);await shot(`raw-preview-${w}`);
            await nativeClick('.amd-mode-rendered');assert.equal(await ev(`!!document.querySelector('.amd-document h2')`),true);await nativeClick('.amd-mode-raw');assert.equal(await ev(`document.querySelector('.amd-raw').value`),`# Raw ${w}\n\n`+rawPayload+'\n');await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor') && !!document.querySelector('.artifact-viewer-version')`,'raw version saved',10000);await waitFor(`document.querySelector('.artifact-viewer-markdown h2')?.textContent==='New structure'`,'saved raw Markdown rendered',8000);
            const rawVersions=(await person('GET',`/api/artifacts/${rawHex}/versions`)).data;assert.equal(rawVersions.length,2);const rawSaved=hexOf(rawVersions.find(v=>v.is_latest)||rawVersions.at(-1));const rawExpected=rawSource.replace('Old words.',rawPayload.replace(/\n/g,'\r\n'));assert.equal(Buffer.from(await bytes(rawSaved)).toString(),rawExpected);assert.equal(await ev(`!!document.querySelector('.artifact-viewer-markdown script,.artifact-viewer-markdown [href^="javascript:"],.artifact-viewer-markdown img[src^="https:"]')`),false);assert.equal(await ev(`!!document.querySelector('.artifact-viewer-markdown [data-artifact="${rawHex}"]')`),true);await shot(`raw-saved-${w}`);await nativeClick('.artifact-viewer-close');
            console.log(`PASS raw mode switches, strict preview/saved rendering and exact bytes ${w}px ${font}px`);




        }
    } finally { if(author)await author.stop().catch(()=>{});await removeBoards(ev,[B]);await client.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
