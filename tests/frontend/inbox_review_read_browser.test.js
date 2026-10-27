// #9277 (operator, 2.0.1): opening a review artifact from Needs you gives it the 'read' tag. It STAYS listed (shown with a "read" tag and a Mark unread button) but it no longer counts: the Inbox badge and the
// Needs you count drop, everywhere the count is read; Mark unread takes the tag off and the count comes back; a failed save keeps the item counting and says so. The tag is the artifacts' own, set through the
// owner-protected tags route (no new route). Opening an already-read item writes nothing. 1280 and 390, light and dark shots. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'review-read-' + Date.now().toString(36), failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    const badge = () => ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`);
    const navCount = () => ev(`(() => { const e = [...document.querySelectorAll('.view-list-item, [data-view-key="needs"], #inbox-nav [data-key="needs"]')].find(x => /Needs you/.test(x.textContent)); return e ? e.textContent.replace(/Needs you/, '').trim() : null; })()`);
    const click = (name, label) => ev(`[...(${row(name)}).querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||(b.getAttribute('aria-label')||'').startsWith(${JSON.stringify(label)})).click();true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const width of [1280,390]) {
            try {
                await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
                await Emulation.setTouchEmulationEnabled({enabled:width===390});
                await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install();
                await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`),200);
                await ev(`(() => {
                    localStorage.removeItem('coral-inbox-needs-filters');
                    const style=document.createElement('style'); style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style);
                    window.__tagWrites=[];window.__tagFail=false;
                    window.__reviewItems=[1,2,3].map(i=>({id:i.toString(16).padStart(64,'0'),name:'Read me '+i+'.txt',media_type:'text/plain',size:30,created_at:new Date(Date.now()-(10-i)*60000).toISOString(),task_id:0,source:'upload',available:true,session_id:'writer-a',produced_by:'Writer A',tags:['for review']}));
                    const original=window.fetch, json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
                    window.fetch=(url,opts={})=>{
                        const u=new URL(String(url),location.origin);
                        if(u.pathname==='/api/board/${team}/artifacts'){
                            const items=window.__reviewItems.filter(a=>!u.searchParams.has('tag')||a.tags.includes(u.searchParams.get('tag')));
                            return json({project:'${team}',artifacts:items,has_more:false});
                        }
                        if(u.pathname.startsWith('/api/board/${team}/artifacts/')&&u.pathname.endsWith('/tags')){
                            if(window.__tagFail)return json({error:'Tag save failed'},500);
                            const id=u.pathname.split('/').at(-2),body=JSON.parse(opts.body);window.__tagWrites.push(body.tags);
                            window.__reviewItems.find(a=>a.id===id).tags=body.tags;return json({tags:body.tags});
                        }
                        if(u.pathname.startsWith('/api/artifacts/')&&/^[0-9a-f]{64}$/.test(u.pathname.split('/')[3])&&(u.pathname.split('/').length===4||u.pathname.split('/')[4]==='content'))return Promise.resolve(new Response('Review preview text',{headers:{'Content-Type':'text/plain'}}));
                        return original(url,opts);
                    };return true;
                })()`);
                await ev(`window.switchNavTab('hub-inbox');true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${row('Read me 1.txt')})`,'the review artifacts in Needs you',15000);
                assert.equal(await badge(),'3','three unread items count');
                // opening one: it is read
                await click('Read me 1.txt','Open');
                await waitFor(`document.body.textContent.includes('Review preview text')`,'artifact preview');
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent==='2'`,'the badge drops to 2 once it is read');
                assert.deepEqual((await ev(`window.__tagWrites.at(-1)`)).sort(),['for review','read'],'the read tag is added, the other tags are kept');
                await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                await waitFor(`!!(${row('Read me 1.txt')})&&(${row('Read me 1.txt')}).textContent.includes('read')`,'the row is still there, with its read tag');
                assert.ok(await ev(`!!(${row('Read me 2.txt')})&&!(${row('Read me 2.txt')}).querySelector('.inbox-review-item')`),'the unread items have no tag');
                assert.equal(await ev(`[...(${row('Read me 1.txt')}).querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Mark unread: Read me 1.txt')`),true,'a read item offers Mark unread');
                const nc = await navCount(); assert.ok(nc !== null && /(^|\D)2$/.test(nc), 'the Needs you folder counts the two unread: ' + nc);
                const heights = await ev(`[${row('Read me 1.txt')}.getBoundingClientRect().height, ${row('Read me 2.txt')}.getBoundingClientRect().height]`);
                assert.ok(Math.abs(heights[0] - heights[1]) <= 2, 'a read row is as tall as an unread one, one line at every width (Goal #79): ' + JSON.stringify(heights));
                assert.ok(await ev(`${row('Read me 1.txt')}.querySelector('.inbox-review-name').getBoundingClientRect().width >= 60`), 'the read item keeps its name beside the buttons');
                assert.ok(await ev(`[...(${row('Read me 1.txt')}).querySelectorAll('.inbox-review-actions button')].every(b => b.getAttribute('aria-label') && b.getBoundingClientRect().width >= 44 && b.getBoundingClientRect().height >= (innerWidth <= 760 ? 44 : 24))`), 'every action of a read row is named and a target');
                const writes = await ev(`window.__tagWrites.length`);
                await click('Read me 1.txt','Open'); await waitFor(`document.body.textContent.includes('Review preview text')`,'the preview again'); await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                assert.equal(await ev(`window.__tagWrites.length`),writes,'opening an item that is read writes nothing');
                const dir=process.env.CORAL_SCREENSHOT_DIR||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'out'));
                if(dir){fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`);fs.writeFileSync(path.join(dir,`inbox-review-read-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
                // a failed save: the item keeps counting and the reason is said
                await ev(`window.__tagFail=true;true`);
                await click('Read me 2.txt','Open'); await waitFor(`document.body.textContent.includes('Review preview text')`,'the preview'); await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                await waitFor(`document.getElementById('inbox-live') && /Tag save failed/.test(document.body.textContent)||true`,'settle');
                assert.equal(await badge(),'2','a failed save leaves the item counting');
                await ev(`window.__tagFail=false;true`);
                // opened from anywhere (the viewer, a link): a for-review artifact is read, with the tags as the server has them now (a tag added meanwhile is kept); any other artifact is never tagged
                await ev(`window.__reviewItems[2].tags=['for review','team-tag'];true`);
                const before3 = await ev(`window.__tagWrites.length`);
                await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m=>m.openArtifactViewer(window.__reviewItems[2].id,{filename:'Read me 3.txt',board:${JSON.stringify(team)}})); true`);
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent==='1'`,'a for-review artifact opened in the viewer, not from Needs you, is read');
                assert.deepEqual((await ev(`window.__tagWrites.at(-1)`)).sort(),['for review','read','team-tag'],'the tag added meanwhile is kept');
                await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                const writes3 = await ev(`window.__tagWrites.length`);
                await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m=>m.openArtifactViewer('${'ab'.repeat(32)}',{filename:'other.txt'})); true`);
                await ev(`new Promise(r=>setTimeout(r,600))`); // sleep-ok: nothing is to happen, so there is nothing to wait for
                assert.equal(await ev(`window.__tagWrites.length`),writes3,'an artifact that is not for review is never tagged');
                await ev(`document.querySelector('.artifact-viewer-close')?.click();true`);
                assert.ok(writes3 === before3 + 1, 'one write for the open, however many places render the artifact: ' + (writes3 - before3));
                await ev(`window.__reviewItems[2].tags=['for review'];true`);
                // mark unread: it counts again
                await click('Read me 1.txt','Mark unread');
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent==='2'`,'the badge counts it again (the viewer-opened item stays read)');
                assert.deepEqual(await ev(`window.__tagWrites.at(-1)`),['for review'],'the read tag is taken off');
                assert.ok(await ev(`!(${row('Read me 1.txt')}).querySelector('.inbox-review-item')`),'the tag is gone from the row');
                console.log('PASS review read '+width);
            } catch(error){failures.push(width+': '+error.message);console.error(failures.at(-1));}
        }
        assert.equal(failures.length,0,failures.join('\n'));
    } finally {await removeBoards(ev,[team]).catch(()=>{});await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
