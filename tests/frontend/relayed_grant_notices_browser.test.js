const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, nextFrame } = require('./helpers/wait');
const { BASE } = require('./test_base');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, card = `.grant-notice[data-grant-id="mg-test"]`;
    const notice = { grant_id: 'mg-test', state: 'live', level: 'view', team: { id: 'research', name: 'Research' }, person: 'Alice Nguyen', hub_user: 'hub-user-a21e67c4', hub: 'studio.example.net', signed_by: 'c81d3e4a', device: 'Work laptop', via: 'hub', created_at: new Date().toISOString(), expires_at: '2026-11-30T14:30:00Z' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => { window.__grants = [${JSON.stringify(notice)}]; window.__grantPosts = 0; window.__grantGets = 0; window.__grantFail = false; const original = window.fetch.bind(window); window.fetch = (u,o) => { const url = String(u?.url || u); if (url.includes('/api/relayed-grant-notices')) { if(o?.method === 'POST') { window.__grantPosts++; return Promise.resolve(new Response(JSON.stringify({state:'revoked'}), {status:window.__grantFail?500:200})); } window.__grantGets++; return Promise.resolve(new Response(JSON.stringify({notices:window.__grants}), {status:200})); } return original(u,o); }; (await import(${S}+'safe_storage.js')).browserLocal.remove('coral-grant-dismissed:mg-test'); window.switchNavTab('hub-inbox'); await (await import(${S}+'inbox_tab.js')).selectInboxTab('needs'); return true; })()`);
        await waitFor(`!!document.querySelector('${card}')`, 'grant card in Needs you', 10000);
        assert.equal(await ev(`(async()=> (await import(${S}+'state.js')).state.grantN)()`), 1);
        assert.match(await ev(`document.querySelector('${card} .grant-head small').textContent`), /^This computer · .+/, 'computer label precedes the date, as in the approved mock');
        assert.match(await ev(`document.querySelector('${card}').textContent`), /Alice Nguyen.*studio.example.net.*Work laptop.*View · Research/s);
        assert.equal(await ev(`window.__grantPosts`), 0);
        await ev(`document.querySelector('${card} .grant-actions button:last-child').click(); true`);
        await waitFor(`document.querySelector('${card} h2')?.textContent.includes('Revoke this')`, 'confirmation');
        await ev(`(async()=>{window.__grants[0].device='Work laptop (trusted)';await (await import(${S}+'relayed_grant_notices.js')).refresh(true);return true;})()`);
        await waitFor(`document.querySelector('${card} h2')?.textContent.includes('Revoke this')`, 'confirmation survives an Inbox refresh');
        assert.match(await ev(`document.querySelector('${card}').textContent`),/Work laptop \(trusted\)/);
        await ev(`(async()=>{window.__grants[0].device='Work laptop';await (await import(${S}+'relayed_grant_notices.js')).refresh(true);return true;})()`);
        await ev(`document.querySelector('${card} .grant-actions button').click(); true`);
        assert.equal(await ev(`window.__grantPosts`), 0, 'Keep access makes no write');
        await ev(`(async()=>{(await import(${S}+'inbox_sidebar.js')).setInboxSearch('not-the-person');return true;})()`);
        await waitFor(`!document.querySelector('${card}')`, 'search excludes grant');
        await ev(`(async()=>{(await import(${S}+'inbox_sidebar.js')).setInboxSearch('Alice');return true;})()`);
        await waitFor(`!!document.querySelector('${card}')`, 'search includes grant');
        await ev(`(async()=>{(await import(${S}+'inbox_sidebar.js')).setInboxSearch('');return true;})()`);
        await ev(`[...document.querySelectorAll('#group-table-view button')].find(b=>b.textContent.trim().startsWith('Access granted')).click();true`);
        assert.equal(await ev(`(async()=> (await import(${S}+'inbox_sidebar.js')).needsListSpec().count)()`),1,'Access granted filter counts the displayed card');
        await ev(`[...document.querySelectorAll('#group-table-view button')].find(b=>b.textContent.trim().startsWith('All')).click();true`);
        const saveShot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, {recursive:true}); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({format:'png',captureBeyondViewport:true})).data,'base64')); };
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:1300,deviceScaleFactor:1,mobile:false});
            for (const theme of ['dark','light']) {
                await ev(`document.documentElement.setAttribute('data-theme','${theme}'); true`);
                await waitFor(`!!document.querySelector('${card}')`, 'responsive card');
                const measured = await ev(`({over:document.documentElement.scrollWidth-document.documentElement.clientWidth,buttons:[...document.querySelectorAll('${card} button')].map(b=>({w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height}))})`);
                assert.ok(measured.over<=1,JSON.stringify(measured)); assert.ok(measured.buttons.every(b=>b.w>=44&&b.h>=44),JSON.stringify(measured));
                await ev(`(async()=>{document.activeElement?.blur();await document.fonts.ready;document.getAnimations().forEach(a=>{try{a.finish();}catch{}});return true;})()`);
                await nextFrame(ev);
                await saveShot(`20909-${width}-${theme}-active`);
                if (process.env.CORAL_SCREENSHOT_DIR) { const clip=await ev(`(()=>{const r=document.querySelector('${card}').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()`); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/20909-${width}-${theme}-card.png`,Buffer.from((await Page.captureScreenshot({format:'png',captureBeyondViewport:true,clip})).data,'base64')); }
                await ev(`document.querySelector('${card} .grant-actions button:last-child').click(); true`);
                await ev(`document.getAnimations().forEach(a=>{try{a.finish();}catch{}});true`);
                const contrast=await ev(`(()=>{const b=document.querySelector('${card} .grant-danger'),s=getComputedStyle(b),c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');const lum=color=>{x.fillStyle=color;x.fillRect(0,0,1,1);const p=[...x.getImageData(0,0,1,1).data].slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return p[0]*.2126+p[1]*.7152+p[2]*.0722;};const a=lum(s.color),d=lum(s.backgroundColor);return (Math.max(a,d)+.05)/(Math.min(a,d)+.05);})()`);
                assert.ok(contrast>=4.5,theme+' Revoke contrast '+contrast);
                await saveShot(`20909-${width}-${theme}-confirm`);
                await ev(`document.querySelector('${card} .grant-actions button').click(); true`);
            }
        }
        await ev(`document.documentElement.style.fontSize='32px';true`);
        assert.equal(await ev(`document.querySelector('${card}').scrollWidth<=document.querySelector('${card}').clientWidth+1`),true,'card has no clipped horizontal content at 200%');
        await ev(`document.documentElement.style.fontSize='';true`);
        await ev(`window.__grantFail=true; document.querySelector('${card} .grant-actions button:last-child').click(); document.querySelector('${card} .grant-actions button:last-child').click(); true`);
        await waitFor(`document.querySelector('${card} [role=alert]')?.textContent.includes('still active')`, 'failure keeps grant active');
        assert.equal(await ev(`document.querySelector('${card} h2').textContent`), 'A Hub member was given access');
        await ev(`window.__grantFail=false; document.querySelector('${card} .grant-actions button:last-child').click(); document.querySelector('${card} .grant-actions button:last-child').click(); true`);
        await waitFor(`document.querySelector('${card} h2')?.textContent==='Access revoked'`, 'successful revoke');
        assert.equal(await ev(`document.querySelectorAll('${card} button').length`),1);
        await ev(`document.querySelector('${card} button').click(); true`);
        await waitFor(`!document.querySelector('${card}')`, 'dismiss removes notice');
        assert.equal(await ev(`(async()=> (await import(${S}+'safe_storage.js')).browserLocal.get('coral-grant-dismissed:mg-test'))()`),'1');
        assert.equal(await ev(`(async()=> (await import(${S}+'state.js')).state.grantN)()`),0);
        // Ended grants have no Revoke; a reload of the feed respects the browser dismissal.
        const ended = await ev(`(async()=>{const m=await import(${S}+'relayed_grant_notices.js');await m.refresh(true);return {rows:m.rows().length,buttons:[...m.card({...window.__grants[0],state:'expired'}).querySelectorAll('button')].map(b=>b.textContent)};})()`);
        assert.equal(ended.rows,0);assert.deepEqual(ended.buttons,['Dismiss']);
        // Exercise supplied text and stale remote controls independently of the feed renderer.
        const result = await ev(`(async()=>{const m=await import(${S}+'relayed_grant_notices.js'), {state}=await import(${S}+'state.js'); const raw=${JSON.stringify(notice)}; raw.person='<img src=x> alice@example.net token=private';raw.device='Long '.repeat(50);raw.hub='https://user:password@studio.example.net/private?secret=private'; const c=m.card(raw);document.body.append(c);const text=c.textContent, images=c.querySelectorAll('img').length; state.hub=true; const gets=window.__grantGets, posts=window.__grantPosts; c.querySelector('.grant-actions button:last-child').click(); await m.refresh(true);const remoteButtons=[...c.querySelectorAll('button')].map(b=>b.textContent);const remoteRows=m.rows().length; const remoteCard=m.card(raw); const buttons=[...remoteCard.querySelectorAll('button')].map(b=>b.textContent);state.hub=false;c.remove();return {text,images,remoteButtons,buttons,remoteRows,noGet:gets===window.__grantGets,noPost:posts===window.__grantPosts,cap:m.clean('😀'.repeat(50)).length};})()`);
        assert.equal(result.images,0); assert.match(result.text, /<img src=x>/); assert.doesNotMatch(result.text,/alice@example|token=private|user:password|secret=private/);
        assert.deepEqual(result.remoteButtons,['Dismiss']); assert.deepEqual(result.buttons,['Dismiss']);assert.equal(result.remoteRows,0);assert.ok(result.noGet&&result.noPost);assert.equal(result.cap,79);
        console.log('PASS Needs-you integration; local confirmation, cancel, failed and successful revoke; browser dismissal; 390/desktop themes; plain text/redaction; stale remote controls and no remote fetch/write.');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
