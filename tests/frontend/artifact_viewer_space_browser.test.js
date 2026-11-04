// #13113: review wide files in the available viewport; layout choices belong to the file type.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { H1, H3, STUB } = require('./helpers/artifact_versions_stub');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const failures = [];
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (dir) { await ev(`Promise.all((document.querySelector('#artifact-viewer .ac-panel')?.getAnimations() || []).map(a => a.finished.catch(() => {}))).then(() => true)`); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); } };
    const open = async (hex = H3, filename = 'wide.html', mediaType = 'text/html') => {
        await ev(`import((window.__coralStatic || '/static/')+'artifact_viewer.js').then(m=>m.openArtifactViewer('${hex}', {filename:${JSON.stringify(filename)}, mediaType:${JSON.stringify(mediaType)}, board:'team-a', from:'Writer · Please review the wide table'})).then(()=>true)`);
        await waitFor(`document.querySelector('#artifact-viewer .ac-toggle:not([hidden])') && document.querySelector('#artifact-viewer .artifact-viewer-body').textContent !== 'Loading…'`, 'file and comments');
        await ev(framesJs(4));
    };
    const close = () => ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
    const click = sel => ev(`document.querySelector(${JSON.stringify('#artifact-viewer '+sel)}).click(); true`);
    const box = sel => ev(`(() => {const r=document.querySelector(${JSON.stringify('#artifact-viewer '+sel)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};})()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const width of [1440,390]) for (const theme of ['dark','light']) for (const font of [16,32]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Emulation.setTouchEmulationEnabled({enabled:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => {const real=window.fetch;window.fetch=(u,o)=>{const url=String(u);if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=for%20review/.test(url))return Promise.resolve(new Response(JSON.stringify({artifacts:[{id:'${H3}',name:'wide.html',tags:['for review'],produced_by:'Writer',media_type:'text/html'}],has_more:false}),{headers:{'content-type':'application/json'}}));if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url))return Promise.resolve(new Response(JSON.stringify({artifacts:[],has_more:false}),{headers:{'content-type':'application/json'}}));return real(u,o);};return true;})()`);
            await ev(`(() => {localStorage.clear();document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='${font}px';const real=window.fetch;window.fetch=(u,o)=>{if (/\\/api\\/artifacts\\/${H3}(?:\\?|$)/.test(String(u)) && !String(u).includes('/versions'))return Promise.resolve(new Response('<!doctype html><h1>Quarterly plan</h1><table style="width:1400px;border-collapse:collapse"><tr>'+Array.from({length:10},(_,i)=>'<th style="border:1px solid;padding:16px">Column '+i+'</th>').join('')+'</tr></table>',{headers:{'content-type':'text/html'}}));return real(u,o);};return true;})()`);
            await open();
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-review-approve:not([hidden])')`, 'Approve and Request changes');
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-frame, #artifact-viewer iframe')`, 'HTML preview');
            if (await ev(`document.querySelector('#artifact-viewer .ac-toggle').getAttribute('aria-expanded')!=='true'`)) await click('.ac-toggle');
            await ev(framesJs(4));
            const label=`${width}-${theme}-${font}`;
            await shot('regular-comments-'+label);
            if (!await ev(`!!document.querySelector('#artifact-viewer .artifact-viewer-fullscreen')`)) { failures.push(label+': missing full-screen control'); await close(); continue; }
            if (width===390) {
                assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-fullscreen').getClientRects().length`),0,'phone already fills viewport');
                await click('.ac-toggle'); await shot('phone-document-'+label); assert.ok(await ev(`(() => {const p=document.querySelector('#artifact-viewer .ac-panel'),m=document.querySelector('#artifact-viewer .artifact-viewer-main');return p.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 1;})()`),'collapsed phone Comments is outside the document'); await close(); continue;
            }
            const control = '#artifact-viewer .artifact-viewer-fullscreen';
            await ev(`document.querySelector('${control}').focus();true`);
            assert.ok(await ev(`document.activeElement.matches('${control}')`),'full-screen is keyboard reachable');
            await Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
            await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
            await ev(framesJs(4));
            assert.equal(await ev(`document.querySelector('${control}').getAttribute('aria-pressed')`),'true');
            assert.match(await ev(`document.querySelector('${control}').getAttribute('aria-label')`),/Exit full screen/);
            const full=await box('.artifact-viewer-content');
            assert.ok(full.x<=1 && full.y<=1 && full.w>=width-1 && full.h>=899,'full screen uses the frame viewport: '+JSON.stringify(full));
            const narrow=await box('.artifact-viewer-body');
            await click('.ac-toggle'); await ev(framesJs(4));
            const wide=await box('.artifact-viewer-body');
            assert.ok(wide.w>narrow.w+150,'collapsing Comments gives its width to the document');
            await shot('full-document-'+label);
            assert.equal(await ev(`localStorage.getItem('coral-artifact-fullscreen:text/html')`),'true','full screen is saved durably by type');
            assert.equal(await ev(`localStorage.getItem('coral-artifact-comments:text/html')`),'closed','Comments choice is saved durably by type');
            assert.ok(await ev(`(() => {const d=document.querySelector('.artifact-viewer-content').getBoundingClientRect();return [...document.querySelectorAll('#artifact-viewer .artifact-viewer-header button')].filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.left>=d.left-1&&r.right<=d.right+1;});})()`),'header controls stay inside the viewer at 200%');
            await close(); await open();
            assert.equal(await ev(`document.querySelector('${control}').getAttribute('aria-pressed')`),'true','HTML full screen is remembered');
            assert.equal(await ev(`document.querySelector('#artifact-viewer .ac-toggle').getAttribute('aria-expanded')`),'false','HTML Comments collapse is remembered');
            await close(); await open(H1,'notes.md','text/markdown');
            assert.equal(await ev(`document.querySelector('${control}').getAttribute('aria-pressed')`),'false','Markdown has its own width preference');
            await click('.ac-toggle'); await close(); await open();
            assert.equal(await ev(`document.querySelector('#artifact-viewer .ac-toggle').getAttribute('aria-expanded')`),'false','Markdown Comments choice does not change HTML');
            await Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
            assert.equal(await ev(`document.querySelector('#artifact-viewer').hidden`),false,'first Escape restores dialog');
            assert.equal(await ev(`document.querySelector('${control}').getAttribute('aria-pressed')`),'false');
            assert.ok(await ev(`document.activeElement.matches('${control}')`),'Escape returns focus to the toggle');
            await Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
            assert.equal(await ev(`document.querySelector('#artifact-viewer').hidden`),true,'second Escape closes');
        }
        if (!failures.length) {
            await Emulation.setDeviceMetricsOverride({width:844,height:390,deviceScaleFactor:1,mobile:true});
            await open();
            assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-fullscreen').getClientRects().length`),0,'landscape phone also has no redundant full-screen toggle');
            await close();
            await Emulation.setDeviceMetricsOverride({width:1440,height:900,deviceScaleFactor:1,mobile:false});
            await Emulation.setTouchEmulationEnabled({enabled:false});
            await ev(`Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Blocked','SecurityError');}});true`);
            await open(H1,'notes.txt','text/plain');
            await click('.artifact-viewer-fullscreen'); await click('.ac-toggle'); await close();
            await open(H1,'notes.txt','text/plain');
            assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-fullscreen').getAttribute('aria-pressed')`),'true','blocked storage keeps a working session preference');
            assert.equal(await ev(`document.querySelector('#artifact-viewer .ac-toggle').getAttribute('aria-expanded')`),'true','blocked storage keeps Comments usable');
            await close();
        }
        assert.deepEqual(failures,[]);
        console.log('PASS viewer space: themes, 200% text, phone, full screen, Escape, per-type choices');
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
