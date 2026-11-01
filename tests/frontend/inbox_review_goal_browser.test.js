// #8917, then #11719: a for-review row in Needs you no longer shows its goal roll-up (the approved three-line row: no goal, no task link, no Goal column); the Filters panel's Goal field still narrows the list and its chip says the goal. Real isolated team; only artifact storage is mocked (as inbox_artifact_review_browser).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'review-inbox-' + Date.now().toString(36), failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    const rows = `document.querySelectorAll('#group-table-view [data-review-artifact]')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD}); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` }); // the Inbox's list is read before a test can set its order: oldest first, set before the page loads (newest first is the default, #11552)
        for (const width of [1440,1600,390]) {
            try {
                await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
                await Emulation.setTouchEmulationEnabled({enabled:width===390});
                await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`),200);
                // Mock only artifact storage; the team exists through the real board API.
                await ev(`(() => {
                    localStorage.removeItem('coral-inbox-needs-filters');
                    const style=document.createElement('style'); style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style);
                    window.__reviewWrites=[];window.__reviewFail=false;
                    window.__reviewItems=Array.from({length:13},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:'Review file '+String(i+1).padStart(2,'0')+'.txt',media_type:'text/plain',size:30,created_at:new Date(Date.now()-(20-i)*60000).toISOString(),task_id:i<3?11:i===3?12:i===4?13:0,task_title:i<3?'Build the installer':i===3?'Write the docs for the whole installer and the update flow, every section, with a screenshot of each step':i===4?'Loose task':'',goal_id:i<3?7:i===3?8:null,goal_title:i<3?'Ship the installer':i===3?'Docs sweep':'',source:'upload',available:true,session_id:i<11?'writer-a':'writer-b',produced_by:i<11?'Writer A':'Writer B',tags:['for review','internal'],uri:'coral://artifacts/'+(i+1).toString(16).padStart(64,'0')}));
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
                await ev(`localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));window.switchNavTab('hub-inbox');true`); // this list is read oldest first: with newest first, a list over the page's 12 rows shows File 01 last, behind "more" (#11552)
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${row('Review file 01.txt')})`,'for-review artifact in Needs you',15000);
                // the row has no goal, no task link and no Goal column (the operator's approved row, #11719): they are in the opened file and in the Filters
                const gone = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view tbody tr')]; return { rows: rows.length, goalCells: rows.filter(r => r.querySelector('.inbox-review-goal, [data-goal-link], [data-task-link]')).length, noGoalText: rows.filter(r => /No goal/.test(r.textContent)).length, goalHead: [...document.querySelectorAll('#group-table-view th')].filter(h => getComputedStyle(h).display !== 'none').some(h => h.textContent.replace(/[\u2191\u2193\u2195]/g, '').trim() === 'Goal') }; })()`);
                assert.ok(gone.rows >= 9 && gone.goalCells === 0 && gone.noGoalText === 0 && !gone.goalHead, 'a review row shows no goal, task link or Goal column: ' + JSON.stringify(gone));
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
                // the goal and the task are in the opened file's Details (#11751): they left the row, the viewer says them
                await ev(`[...document.querySelectorAll('#group-table-view tbody tr button')].find(b => b.getAttribute('aria-label') === 'Open Review file 01.txt').click(); true`);
                await waitFor(`!!document.querySelector('.artifact-viewer .details-toggle:not([hidden])')`, 'the viewer has a Details button', 10000);
                await ev(`(() => { const b = document.querySelector('.artifact-viewer .details-toggle'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`);
                await waitFor(`/Ship the installer/.test((document.querySelector('.artifact-viewer .detail-details') || {}).textContent || '')`, 'the Details name the goal', 6000).catch(() => {});
                const facts = await ev(`(document.querySelector('.artifact-viewer .detail-details') || {}).textContent || ''`);
                assert.ok(/Goal/.test(facts) && /Ship the installer/.test(facts) && /Task/.test(facts) && /Build the installer/.test(facts), 'the opened file\'s Details say its goal and its task: ' + JSON.stringify(facts.slice(0, 200)));
                if (dir) { fs.writeFileSync(path.join(dir, `review-details-${width}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
                // a goal or task title with a right-to-left override is written out, not drawn (it is an agent's text, like the rest of the row)
                await ev(`(async () => { const v = await import((window.__coralStatic || '/static/') + 'artifact_viewer.js'); v.openArtifactViewer('${'0'.repeat(63)}1', { filename: 'hidden.txt', goal: 'Ship\\u202e it', task: 'Build\\u200b it' }); return true; })()`);
                await waitFor(`/<U\\+202E>/.test((document.querySelector('.artifact-viewer .detail-details') || {}).textContent || '')`, 'the Details write a hidden character out', 8000);
                assert.ok(await ev(`(() => { const t = document.querySelector('.artifact-viewer .detail-details').textContent; return t.includes('Ship<U+202E> it') && t.includes('Build<U+200B> it') && !/[\\u202e\\u200b]/.test(t); })()`), 'the goal and task titles are written out, not stripped or drawn');
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                console.log('PASS review goal ' + width);
                console.log('PASS review goal ' + width);
            } catch(error){failures.push(width+': '+error.message);console.error(failures.at(-1));}
        }
        assert.equal(failures.length,0,failures.join('\n'));
    } finally {await removeBoards(ev,[team]).catch(()=>{});await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
