// Hidden code-point handling through the real owner editor and immutable-version API.
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
    const B = 'mdhidden-' + Date.now().toString(36); let author;
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


        for(const [w,theme,font] of [[390,'dark',32],[1280,'light',16]]) {
            await Emulation.setDeviceMetricsOverride({width:w,height:900,deviceScaleFactor:1,mobile:w===390});
            await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${font}px';true`);
            for(const cp of [0xad,0x34f,0x85,0x180e,0x115f,0x1160,0x3164,0xfff9,0xfffa,0xfffb]) {
                const char=String.fromCodePoint(cp),code=cp.toString(16).toUpperCase().padStart(4,'0'),label='U+'+code,name=`hidden-${w}-${code}.md`;
                const source=`\ufeff# Hidden character ${w}/${code}\r\n\r\nSafe words.\r\n\r\nBefore${char}after.\r\n\r\n[Visible link](https://example.com/${char})\r\n\r\n- Editable item.\r\n`;
                const original=await upload(name,source);await open(original,name);await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'owner Edit for hidden source',8000);await edit();await waitFor(`!!document.querySelector('.amd-text')`,'rendered editor ready',8000);
                await ev(`[...document.querySelectorAll('.amd-block')].find(e=>e.textContent.includes('Before'))?.scrollIntoView({block:'center'});true`);if(cp===0xad)await shot(`hidden-rendered-${w}-${code}`);
                assert.ok(await ev(`document.querySelector('.amd-document').textContent.includes(${JSON.stringify(label)})`),label+' code point is visible');
                assert.equal(await ev(`[...document.querySelectorAll('.amd-text')].some(e=>e.textContent.includes('Before'))`),false,label+' block stays read-only');
                assert.ok(await ev(`[...document.querySelectorAll('.amd-block')].find(e=>e.textContent.includes('Visible link'))?.querySelector('.amd-readonly')?.textContent.includes(${JSON.stringify(label)})`),label+' is also named for a source-only destination');
                await ev(`(()=>{const e=[...document.querySelectorAll('.amd-text')].find(e=>e.textContent==='Safe words.');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
                await client.Input.insertText({text:char});assert.ok(await ev(`[...document.querySelectorAll('.amd-text')].some(e=>e.textContent==='Safe words.')`),'native typing is refused');assert.match(await ev(`document.querySelector('.amd-status').textContent`),/hidden/i);
                await ev(`(()=>{const e=[...document.querySelectorAll('.amd-text')].find(e=>e.textContent==='Safe words.'),data=new DataTransfer();data.setData('text/plain',${JSON.stringify(char)});e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));return true;})()`);
                assert.ok(await ev(`[...document.querySelectorAll('.amd-text')].some(e=>e.textContent==='Safe words.')`),'paste handler refuses hidden text');
                await ev(`(()=>{const e=[...document.querySelectorAll('.amd-text')].find(e=>e.textContent==='Editable item.');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
                await client.Input.insertText({text:'More\n'+char});assert.ok(await ev(`[...document.querySelectorAll('.amd-text')].some(e=>e.textContent==='Editable item.')`),'multiline native insertion refuses hidden text immediately');
                await nativeClick('.amd-mode-raw');await waitFor(`!!document.querySelector('.amd-raw')`,'raw source ready',5000);assert.equal(await ev(`document.querySelector('.amd-raw-warning').hidden`),false,'raw mode warns');
                await ev(`(()=>{const e=document.querySelector('.amd-raw');e.focus();e.setSelectionRange(e.value.length,e.value.length);return true;})()`);const tail=' Raw'+char+' words.';await client.Input.insertText({text:tail});assert.equal(await ev(`document.querySelector('.amd-raw-warning').hidden`),false);
                await ev(`document.querySelector('.amd-raw-warning').scrollIntoView({block:'center'});true`);if(cp===0xad)await shot(`hidden-raw-warning-${w}-${code}`);await nativeClick('.amd-save');await waitFor(`!document.querySelector('.amd-editor')&&!!document.querySelector('.artifact-viewer-version')`,'raw hidden source saved',10000);
                const versions=(await person('GET',`/api/artifacts/${original}/versions`)).data;assert.equal(versions.length,2);const saved=hexOf(versions.find(v=>v.is_latest)||versions.at(-1));assert.deepEqual(Buffer.from(await bytes(saved)),Buffer.from(source+tail),'raw source retains original BOM/CRLF and every hidden code point');assert.deepEqual(Buffer.from(await bytes(original)),Buffer.from(source));await nativeClick('.artifact-viewer-close');
                console.log(`PASS ${label}: read-only marker, native typing/paste refusal, raw warning and exact saved bytes ${w}px`);
            }
        }
    } finally { if(author)await author.stop().catch(()=>{});await removeBoards(ev,[B]);await client.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
