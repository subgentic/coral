// #20937: local human controls, once-only secrets, lower-cap Allow, cancel, safe text,
// key limits and failures. Browser fetch fixtures never create actual links or keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const click = (selector, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)}+' button')].find(b => b.textContent === ${JSON.stringify(text)}); if (!b) throw Error('missing button'); b.click(); return true; })()`);
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, {recursive:true});
        const capture = async suffix => fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}${suffix}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
        await capture('');
        const selector = name.includes('-key') ? '#hub-join-keys' : '[data-join-request]';
        await ev(`(() => {const r=document.querySelector(${JSON.stringify(selector)});[...r.querySelectorAll('button')].at(-1)?.scrollIntoView({block:'end',behavior:'instant'});return true;})()`);
        await capture('-actions');
        const visibility = await ev(`(() => {const r=document.querySelector(${JSON.stringify(selector)}),b=[...r.querySelectorAll('button')].at(-1),q=b.getBoundingClientRect(),x=q.x+q.width/2;const hits=[q.top+1,q.top+q.height/2,q.bottom-1].map(y=>{const n=document.elementFromPoint(x,y);return {y,okay:n===b||b.contains(n),hit:n?.id||n?.className};});const ancestors=[];for(let p=b.parentElement;p;p=p.parentElement){const c=getComputedStyle(p),z=p.getBoundingClientRect();ancestors.push({id:p.id,cls:p.className,overflow:c.overflowY,top:z.top,bottom:z.bottom,client:p.clientHeight,scroll:p.scrollHeight,scrollTop:p.scrollTop});}return {okay:hits.every(h=>h.okay),hits,ancestors};})()`);
        assert.equal(visibility.okay,true,`${name}: the last action is fully reachable after scrolling: ${JSON.stringify(visibility)}`);
        await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start',behavior:'instant'});true`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch; window.__joinCalls = []; window.__keyFail = false; window.__deleteFail = false;
            window.__keys = [{ id:'key-1', name:'Studio <Hub>', created_at: new Date().toISOString() }];
            window.__requests = [{ id:'request-1', hub:'https://studio.example.net', cap_asked:'launch', created_at:new Date().toISOString(), expires_at:new Date(Date.now()+300000).toISOString(), links:1,max:8,via:'Studio <Hub>' }];
            window.fetch = async (u, o = {}) => {
                const path = new URL(String(u), location.href).pathname, method = o.method || 'GET';
                const answer = (body, status = 200) => new Response(JSON.stringify(body), {status,headers:{'content-type':'application/json'}});
                if (path.startsWith('/api/cloud/link-keys')) {
                    window.__joinCalls.push({path,method,body:o.body});
                    if (method==='GET') return answer({keys:window.__keys});
                    if (method==='POST') { if(window.__keyFail) return answer({error:'too_many_keys'},409); const made={id:'key-2',name:JSON.parse(o.body).name,key:'once-only-test-key'}; window.__keys.push({...made,key:undefined,created_at:new Date().toISOString()}); return answer(made); }
                    if(window.__deleteFail) return answer({error:'unavailable'},503);
                    window.__keys=window.__keys.filter(k=>!path.endsWith(k.id));return answer({ok:true});
                }
                if (path==='/api/cloud/link-requests') return answer({requests:window.__requests});
                if (path.startsWith('/api/cloud/link-requests/')) { window.__joinCalls.push({path,method,body:o.body}); return answer(path.endsWith('/allow')?{code:'73942186',cap:JSON.parse(o.body).cap,expires_in:path.includes('expire')?1:300}:{ok:true}); }
                if(path==='/api/cloud/links') return answer({links:window.__joinLinks||[]});
                return real(u,o);
            };
        })();` });
        for (const width of [1280,390]) for (const theme of ['dark', 'light']) {
            await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-theme', '${theme}');` });
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('[data-join-request]')`, 'local join request in Needs you', 12000);
            assert.equal(await ev(`document.querySelector('[data-needs-tab=you] .chip-count')?.textContent`),'1','the Waiting on you count includes the request');
            assert.equal(await ev(`(async () => {const m=await import((window.__coralStatic||'/static/')+'hub_join.js');return m.joinCount('no-match-here')===0 && !m.hasJoinCards('no-match-here') && m.joinCount('studio')===1;})()`),true,'request search and counts agree');
            assert.equal(await ev(`document.querySelector('[data-join-request] a') === null`), true, 'Hub origin is never linked');
            assert.match(await text('[data-join-request]'), /via key Studio <Hub>/, 'key identity is text');
            assert.equal(await ev(`document.querySelector('[data-join-request] code')===null`), true, 'code absent before Allow');
            assert.equal(await ev(`document.querySelector('[data-join-request] select').options.length`),3,'only up-to-requested access');
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth+1`),true,'no horizontal clipping');
            assert.equal(await ev(`[...document.querySelectorAll('[data-join-request] button, [data-join-request] select')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44;})`),true,'44px touch controls');
            await shot(`hub-join-${width}-${theme}-request`);
            if (process.env.CORAL_SCREENSHOT_DIR) {
                const clip = await ev(`(() => {const r=document.querySelector('[data-join-request]').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()`);
                fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/hub-join-${width}-${theme}-request-card.png`, Buffer.from((await Page.captureScreenshot({format:'png',captureBeyondViewport:true,clip})).data,'base64'));
            }
            await ev(`(() => {const s=document.querySelector('[data-join-request] select');s.value='view';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
            await ev(`(async () => { const wrap=document.querySelector('.hub-join-requests'), host=wrap.parentNode; wrap.remove(); const m=await import((window.__coralStatic||'/static/')+'hub_join.js'); m.mountJoinRequests(host); return true; })()`);
            assert.equal(await ev(`document.querySelector('[data-join-request] select').value`),'view','a redraw preserves lower access');
            await click('[data-join-request]','Allow');
            await waitFor(`document.querySelector('[data-join-request] code')?.textContent==='7394 2186'`, 'one-time code', 5000);
            assert.equal(await ev(`JSON.parse(window.__joinCalls.find(c=>c.path.endsWith('/allow')).body).cap`),'view');
            await shot(`hub-join-${width}-${theme}-code`);
            await click('[data-join-request]','Cancel connection');
            await waitFor(`document.querySelector('[data-join-request]')?.textContent.includes('Request denied')`, 'canceled code',5000);
            assert.equal(await ev(`document.querySelector('[data-join-request] code')===null`),true);
            assert.equal(await ev(`window.__joinCalls.filter(c=>c.path.endsWith('/deny')).length`),1);
            if (width===1280 && theme==='dark') {
                await click('[data-join-request]','Dismiss');
                await ev(`(async () => {const now=Date.now();window.__requests=['expire','connected'].map(id=>({id,hub:'https://'+id+'.example.net',cap_asked:'view',created_at:new Date(now).toISOString(),expires_at:new Date(now+300000).toISOString(),links:1,max:8}));window.__realClock=Date.now;Date.now=()=>window.__realClock()+21000;const m=await import((window.__coralStatic||'/static/')+'hub_join.js');await m.loadJoinRequests(()=>document.dispatchEvent(new CustomEvent('coral:join-requests-changed')));Date.now=window.__realClock;return true;})()`);
                await click('[data-join-request=expire]','Allow');
                await waitFor(`document.querySelector('[data-join-request=expire]')?.textContent.includes('Connection code expired')`, 'expired code terminal state',5000);
                assert.equal(await ev(`document.querySelector('[data-join-request=expire] code')===null`),true,'expired code erased');
                await click('[data-join-request=connected]','Allow');
                await ev(`(async () => {window.__joinLinks=[{hub_origin:'https://connected.example.net'}];Date.now=()=>window.__realClock()+42000;const m=await import((window.__coralStatic||'/static/')+'hub_join.js');await m.loadJoinRequests(()=>document.dispatchEvent(new CustomEvent('coral:join-requests-changed')));Date.now=window.__realClock;return true;})()`);
                await waitFor(`document.querySelector('[data-join-request=connected]')?.textContent.includes('Hub is connected')`, 'connection confirmed by link list',5000);
                assert.equal(await ev(`document.querySelector('[data-join-request=connected] code')===null`),true,'connected code erased');
            }
            await ev(`window.showSettingsModal('network'); true`);
            await waitFor(`document.querySelector('#hub-join-keys')?.textContent.includes('Studio <Hub>')`, 'local keys',8000);
            assert.match(await text('#hub-join-keys'),/1 of 8/);
            await ev(`document.getElementById('hub-join-keys').scrollIntoView({block:'start',behavior:'instant'});true`);
            await shot(`hub-join-${width}-${theme}-keys`);
            await click('#hub-join-keys','Revoke'); await click('#hub-join-keys','Cancel');
            assert.equal(await ev(`window.__joinCalls.some(c=>c.method==='DELETE')`),false,'Cancel writes nothing');
            await click('#hub-join-keys','Create key');
            await ev(`(() => {const i=document.querySelector('#hub-join-keys input');i.value='Travel Hub';i.form.requestSubmit();return true;})()`);
            await waitFor(`document.querySelector('#hub-join-keys code')?.textContent==='once-only-test-key'`,'key shown once',5000);
            await shot(`hub-join-${width}-${theme}-key-shown`);
            await click('#hub-join-keys','Revoke'); await click('#hub-join-keys','Cancel');
            await waitFor(`document.querySelectorAll('.hub-join-key').length===2`,'canceling revoke keeps the just-created key listed',5000);
            assert.equal(await ev(`document.querySelector('#hub-join-keys code')===null`),true,'list never reveals key');
            await ev(`window.__deleteFail=true;true`); await click('#hub-join-keys','Revoke'); await click('#hub-join-keys','Revoke key');
            await waitFor(`!!document.querySelector('#hub-join-keys [role=alert]')`,'revoke failure',5000);
            assert.equal(await ev(`window.__keys.length`),2,'failed revoke preserves key');
            await ev(`window.__deleteFail=false;true`); await click('#hub-join-keys','Revoke key');
            await waitFor(`document.querySelector('#hub-join-keys')?.textContent.includes('revoked.')`,'revoke retry',5000);
            await ev(`window.__keyFail=true;true`); await click('#hub-join-keys','Create key');
            await ev(`(() => {const i=document.querySelector('#hub-join-keys input');i.value='Another';i.form.requestSubmit();return true;})()`);
            await waitFor(`document.querySelector('#hub-join-keys [role=alert]')?.textContent.includes('eight live keys')`,'limit error',5000);
            await ev(`window.hideSettingsModal();true`);
            assert.equal(await ev(`document.getElementById('hub-join-keys')===null`),true,'closing clears key controls');
            await ev(`(async () => { const s=await import((window.__coralStatic||'/static/')+'state.js'); window.__beforeHubCalls=window.__joinCalls.length; s.state.hub=true; const m=await import((window.__coralStatic||'/static/')+'hub_join.js'); await m.initJoinKeys(); s.state.hub=false; return true; })()`);
            assert.equal(await ev(`window.__joinCalls.length===window.__beforeHubCalls && !document.getElementById('hub-join-keys')`),true,'Hub mode never calls local key management');
            console.log('PASS '+width+'px '+theme+': local request and key lifecycle');
        }
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
