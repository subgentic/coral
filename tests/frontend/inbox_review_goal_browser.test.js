// #8917: a for-review row in Needs you shows its goal roll-up like the Artifacts folder (the goal, its task under it, or "No goal"): a sortable Goal column, a Goal filter, links that open in the Inbox;
// at 390 the goal is on the row's second line. Real isolated team; only artifact storage is mocked (as inbox_artifact_review_browser).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'review-inbox-' + Date.now().toString(36), failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    const rows = `document.querySelectorAll('#group-table-view [data-review-artifact]')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const width of [1280,390]) {
            try {
                await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
                await Emulation.setTouchEmulationEnabled({enabled:width===390});
                await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install();
                await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`),200);
                // Mock only artifact storage; the team exists through the real board API.
                await ev(`(() => {
                    localStorage.removeItem('coral-inbox-needs-filters');
                    const style=document.createElement('style'); style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style);
                    window.__reviewWrites=[];window.__reviewFail=false;
                    window.__reviewItems=Array.from({length:13},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:'Review file '+String(i+1).padStart(2,'0')+'.txt',media_type:'text/plain',size:30,created_at:new Date(Date.now()-(20-i)*60000).toISOString(),task_id:i<3?11:i===3?12:i===4?13:0,task_title:i<3?'Build the installer':i===3?'Write the docs':i===4?'Loose task':'',goal_id:i<3?7:i===3?8:null,goal_title:i<3?'Ship the installer':i===3?'Docs sweep':'',source:'upload',available:true,session_id:i<11?'writer-a':'writer-b',produced_by:i<11?'Writer A':'Writer B',tags:['for review','internal'],uri:'coral://artifacts/'+(i+1).toString(16).padStart(64,'0')}));
                    const original=window.fetch, json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
                    window.fetch=(url,opts={})=>{
                        const u=new URL(String(url),location.origin);
                        if(u.pathname==='/api/board/${team}/artifacts'){
                            const items=window.__reviewItems.filter(a=>!u.searchParams.has('tag')||a.tags.includes(u.searchParams.get('tag'))),offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||100);
                            return json({project:'${team}',artifacts:items.slice(offset,offset+limit),has_more:offset+limit<items.length});
                        }
                        if(u.pathname.startsWith('/api/board/${team}/artifacts/')&&u.pathname.endsWith('/tags')){
                            if(window.__reviewFail)return json({error:'Review save failed'},500);
                            const id=u.pathname.split('/').at(-2),body=JSON.parse(opts.body);window.__reviewWrites.push(body);
                            window.__reviewItems.find(a=>a.id===id).tags=body.tags;return json({tags:body.tags});
                        }
                        if(u.pathname.startsWith('/api/artifacts/')&&/^[0-9a-f]{64}$/.test(u.pathname.split('/')[3])&&(u.pathname.split('/').length===4||u.pathname.split('/')[4]==='content'))return Promise.resolve(new Response('Review preview text',{headers:{'Content-Type':'text/plain'}}));
                        return original(url,opts);
                    };return true;
                })()`);
                await ev(`window.switchNavTab('hub-inbox');true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${row('Review file 01.txt')})`,'for-review artifact in Needs you',15000);
                const goals = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => ({ name: (r.querySelector('.inbox-review-name') || {}).textContent, goal: (r.querySelector('.inbox-review-goal [data-goal-link]') || {}).textContent || ((r.querySelector('.inbox-review-nogoal') || {}).textContent) || null, task: (r.querySelector('.inbox-review-task') || {}).textContent || null, taskShown: !!(r.querySelector('.inbox-review-task') && r.querySelector('.inbox-review-task').getClientRects().length), inLine2: !!r.querySelector('td[data-key=goal].dt-line-2, td[data-key=goal][class*="line-2"]') }))`);
                const by = n => goals.find(g => g.name === n);
                assert.equal(by('Review file 01.txt').goal, 'Ship the installer', 'a review row shows its goal: ' + JSON.stringify(by('Review file 01.txt')));
                assert.equal(by('Review file 04.txt').goal, 'Docs sweep');
                assert.equal(by('Review file 05.txt').goal, 'No goal', 'a task with no goal says No goal: ' + JSON.stringify(by('Review file 05.txt')));
                assert.equal(by('Review file 09.txt').goal, 'No goal');
                assert.equal(by('Review file 01.txt').task, 'Build the installer', 'its task is under the goal');
                assert.equal(by('Review file 05.txt').task, 'Loose task'); assert.equal(by('Review file 09.txt').task, null, 'no task, none shown');
                if (width === 390) { assert.equal(by('Review file 01.txt').taskShown, false, 'a phone row shows the goal only'); assert.ok(by('Review file 01.txt').inLine2, 'the goal is on the row\'s second line: ' + JSON.stringify(by('Review file 01.txt'))); }
                else assert.equal(by('Review file 01.txt').taskShown, true);
                if (width === 1280) {
                    assert.ok(await ev(`[...document.querySelectorAll('#group-table-view th')].some(h => h.textContent.replace(/[\u2191\u2193\u2195]/g, '').trim() === 'Goal')`), 'the table has a Goal column');
                    const geo = await ev(`(() => { const r = ${row('Review file 01.txt')}, g = r.querySelector('.inbox-review-goal [data-goal-link]').getBoundingClientRect(), t = r.querySelector('.inbox-review-task').getBoundingClientRect(); return { under: t.top >= g.bottom - 1, h: Math.round(r.getBoundingClientRect().height) }; })()`);
                    assert.ok(geo.under, 'the task is under the goal: ' + JSON.stringify(geo));
                    // sortable: Docs sweep, Ship the installer, then No goal last
                    await ev(`[...document.querySelectorAll('#group-table-view th button.dt-sort, #group-table-view th .dt-sort')].find(b => /^Goal/.test(b.textContent.trim())).click(); true`);
                    await waitFor(`(() => { const t = [...document.querySelectorAll('#group-table-view tbody tr .inbox-review-goal')].map(c => c.firstChild.textContent); return t[0] === 'Docs sweep'; })()`, 'sorted by goal', 6000);
                    const order = await ev(`[...document.querySelectorAll('#group-table-view tbody tr .inbox-review-goal')].map(c => c.firstChild.textContent)`);
                    assert.deepEqual([...new Set(order)], ['Docs sweep', 'Ship the installer', 'No goal'], 'sorted by goal, No goal last: ' + JSON.stringify(order));
                }
                // the Filters panel's Goal field
                await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`);
                await waitFor(`!document.querySelector('.inbox-folder-toolbar .list-bar-menu').hidden`, 'the Filters panel', 6000);
                const opts = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-menu select')].filter(s => /^Goal/.test((s.labels[0] || {}).textContent || s.getAttribute('aria-label') || '')).map(s => [...s.options].map(o => o.textContent))[0]`);
                assert.deepEqual(opts, ['Any goal', 'Docs sweep', 'Ship the installer', 'No goal'], 'the Goal field offers the goals, No goal last: ' + JSON.stringify(opts));
                await ev(`(() => { const s = [...document.querySelectorAll('.inbox-folder-toolbar .list-bar-menu select')].find(x => /^Goal/.test((x.labels[0] || {}).textContent || '')); s.value = 'Docs sweep'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`document.querySelectorAll('#group-table-view [data-review-artifact]').length === 1`, 'the filter narrows to one goal', 6000);
                assert.match(await ev(`document.querySelector('.inbox-folder-toolbar').textContent`), /Goal: Docs sweep/, 'the chip says the goal');
                await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`);
                const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
                // clear the filter, shoot, then open the goal in place
                await ev(`window.__resetNeeds = true; localStorage.removeItem('coral-inbox-needs-filters'); true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await ev(`(() => { const x = [...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip')].find(c => /Goal/.test(c.textContent)); if (x) x.click(); return true; })()`);
                await waitFor(`document.querySelectorAll('#group-table-view [data-review-artifact]').length >= 12`, 'the filter cleared', 8000);
                if (dir) { fs.mkdirSync(dir, { recursive: true }); for (const theme of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`); fs.writeFileSync(path.join(dir, `inbox-review-goal-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
                await ev(`(${row('Review file 01.txt')}).querySelector('[data-goal-link]').click(); true`);
                await waitFor(`location.pathname.startsWith('/inbox/goals/') && location.pathname.endsWith('/7')`, 'the goal opens in the Inbox, in place', 8000);
                assert.equal(await ev(`document.body.dataset.navTab`), 'hub-inbox', 'the Inbox stays');
                console.log('PASS review goal ' + width);
            } catch(error){failures.push(width+': '+error.message);console.error(failures.at(-1));}
        }
        assert.equal(failures.length,0,failures.join('\n'));
    } finally {await removeBoards(ev,[team]).catch(()=>{});await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
