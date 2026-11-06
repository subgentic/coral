// Actual owner save and explicit Send; the real recipient reads the server diff and replies.
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
    const B = 'edsend-' + Date.now().toString(36); let author;
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

        for(const [w,theme,font] of [[1280,'dark',16],[390,'light',16],[390,'dark',32],[1280,'light',32]]) {
            await Emulation.setDeviceMetricsOverride({width:w,height:900,deviceScaleFactor:1,mobile:w===390});
            await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${font}px';true`);
            const name=`edit-send-${w}-${font}.md`,source=`# Delivery report ${w}/${font}\n\nA **careful sentence** remains.\n\nUnchanged words.${w===1280&&font===32?' x'.repeat(1000):''}\n`;
            const original=await upload(name,source);await open(original,name);
            await waitFor(`!document.querySelector('.artifact-viewer-edit').hidden`,'owner Edit',10000);
            await shot(`edit-send-before-${w}-${font}`);
            await edit();await waitFor(`!!document.querySelector('.amd-text')`,'editable words',8000);await type('careful sentence','clear sentence');await nativeClick('.amd-save');
            await waitFor(`!document.querySelector('.amd-editor') && !document.querySelector('.artifact-edit-send-action').hidden`,'saved version offers separate Send',12000);
            const versions=(await person('GET',`/api/artifacts/${original}/versions`)).data;assert.equal(versions.length,2);const savedHex=hexOf(versions.find(v=>v.is_latest)||versions[versions.length-1]);
            assert.deepEqual(Buffer.from(await bytes(savedHex)),Buffer.from(source.replace('careful sentence','clear sentence')));
            let comments=(await person('GET',`/api/artifacts/${savedHex}/comments?board=${B}`)).data;assert.equal((comments.comments||[]).length,0,'saving creates no send thread');
            await nativeClick('.artifact-edit-send-action');await waitFor(`!!document.querySelector('.aes-picker input:not([aria-disabled="true"])')`,'real recipient available',10000);
            comments=(await person('GET',`/api/artifacts/${savedHex}/comments?board=${B}`)).data;assert.equal((comments.comments||[]).length,0,'opening picker creates no thread');
            if(w===390)assert.ok(await ev(`[...document.querySelectorAll('.artifact-edit-send-dialog .btn,.artifact-edit-send-dialog .ac-ask-label')].filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().height>=44)`),'phone picker targets are 44px');
            await shot(`edit-send-picker-${w}-${font}`);await nativeClick('.aes-picker input:not([aria-disabled="true"])');await nativeClick('.aes-picker .ac-ask-go');
            await waitFor(`!document.querySelector('.aes-thread').hidden`,'server confirms delivery thread',10000,`document.querySelector('.artifact-edit-send-dialog')?.textContent`);
            const cap=(await person('GET',`/api/board/${B}/artifacts/${savedHex}/edit/send`)).data;assert.deepEqual(cap.sent_to,['Writer']);assert.ok(cap.thread_id);
            const delivery=await httpJson('GET',`/api/board/${B}/messages?subscriber_id=Markdown%20Writer`,undefined,{'X-Coral-Session-Token':author.token});assert.equal(delivery.status,200,JSON.stringify(delivery));
            const messages=delivery.data;assert.ok(Array.isArray(messages));const msg=messages.find(m=>m.content?.includes(savedHex));assert.ok(msg,'recipient reads its actual board delivery');
            assert.match(msg.content,/From the Operator/);assert.match(msg.content,/untrusted/);assert.ok(msg.content.includes(original));if(w===1280&&font===32){assert.match(msg.content,/limit|too large|too long|fit/i);assert.ok(!msg.content.includes('-A **careful sentence** remains.'),'over-cap delivery contains no partial diff');}else{assert.ok(msg.content.includes('-A **careful sentence** remains.'));assert.ok(msg.content.includes('+A **clear sentence** remains.'));}
            const again=await person('POST',`/api/board/${B}/artifacts/${savedHex}/edit/send`,{agents:['Writer']});assert.equal(again.status,200);assert.equal(again.data.results[0].state,'already_sent');assert.equal(again.data.thread_id,cap.thread_id);
            const reply=await httpJson('POST',`/api/artifacts/${savedHex}/comments/${cap.thread_id}/reply`,{body:'I received the changed sentence and both versions.'},{'X-Coral-Session-Token':author.token});assert.equal(reply.status,201,JSON.stringify(reply));
            await nativeClick('.aes-thread');await waitFor(`document.querySelector('.ac-panel')?.textContent.includes('I received the changed sentence')`,'agent reply in existing thread',10000);
            await shot(`edit-send-thread-${w}-${font}`);if(w===390)await nativeClick('.ac-sheet-close');await nativeClick('.artifact-viewer-close');
            console.log(`PASS real edit/save/explicit send, agent receives unified diff and replies, idempotent resend ${w}px ${theme} ${font}px`);
        }
    } finally { if(author)await author.stop().catch(()=>{});await removeBoards(ev,[B]);await guard.restore();await client.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
