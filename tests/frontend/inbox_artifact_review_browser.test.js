// #8628: for-review artifacts join Needs you; ten per producer, overflow disclosed,
// preview stays in Inbox, and Approve (which replaced Mark reviewed, #136584) takes the row out, tells the uploader once and shows the viewer's "Approved" state; Request changes asks the uploader through a comment.
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
        for (const width of [1280,1024,390,360]) { // 360 is the narrow phone (#9922)
            try {
                await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width<=390});
                await Emulation.setTouchEmulationEnabled({enabled:width<=390});
                await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`),200);
                // Mock only artifact storage; the team exists through the real board API.
                await ev(`(() => {
                    localStorage.removeItem('coral-inbox-needs-filters');
                    const style=document.createElement('style'); style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style);
                    window.__reviewWrites=[];window.__reviewFail=false;window.__decisions=[];window.__comments=[];
                    window.__reviewItems=Array.from({length:13},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:'Review file '+String(i+1).padStart(2,'0')+'.txt',media_type:'text/plain',size:30,created_at:new Date(Date.now()-(20-i)*60000).toISOString(),task_id:0,source:'upload',available:true,session_id:i<11?'writer-a':'writer-b',produced_by:i<11?'Writer A':'Writer B',tags:['for review','internal'],uri:'coral://artifacts/'+(i+1).toString(16).padStart(64,'0')}));
                    window.__reviewItems[2].version=3; window.__reviewItems[2].versions=3; // file 03 is the third version of its file; versions 1 and 2 were decided long ago (#11890): the list says so, no request does
                    window.__versionCalls=[];
                    const original=window.fetch, json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
                    window.fetch=(url,opts={})=>{
                        const u=new URL(String(url),location.origin);
                        if(u.pathname==='/api/board/${team}/artifacts'){
                            const items=window.__reviewItems.filter(a=>!u.searchParams.has('tag')||a.tags.includes(u.searchParams.get('tag'))),offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||100);
                            return json({project:'${team}',artifacts:items.slice(offset,offset+limit),has_more:offset+limit<items.length});
                        }
                        if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.endsWith('/star')&&u.pathname.split('/').length===5&&(opts.method==='PUT'||opts.method==='DELETE')){ const id=u.pathname.split('/')[3], it=window.__reviewItems.find(x=>x.id===id); if(!it)return json({error:'not found'},404); it.starred=opts.method==='PUT'; window.__starCalls=(window.__starCalls||[]).concat(opts.method+' '+id); return json({starred:it.starred}); } // what the server does: the next list says it
                        if(u.pathname.startsWith('/api/board/${team}/artifacts/')&&u.pathname.endsWith('/review')&&opts.method==='POST'){
                            if(window.__reviewFail)return json({error:'Review save failed'},500);
                            const id=u.pathname.split('/').at(-2),body=JSON.parse(opts.body),it=window.__reviewItems.find(a=>a.id===id);window.__decisions.push({id,decision:body.decision});
                            if(body.decision==='approve'){it.tags=it.tags.filter(t=>t!=='for review'&&t!=='read'&&t!=='changes requested').concat('approved');it.review={state:'approved',at:new Date().toISOString()};}
                            else{it.tags=[...new Set(it.tags.concat('for review','changes requested'))].filter(t=>t!=='read');}  // the real route takes 'read' off: it is something to read again (artifact_reviews.go)
                            return json({id,state:body.decision==='approve'?'approved':'changes requested',changed:true,tags:it.tags,review:it.review||null,delivered:body.decision==='approve',to:'Writer'});
                        }
                        if(u.pathname.endsWith('/versions'))window.__versionCalls.push(u.pathname);
                        if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.endsWith('/versions')&&window.__twoVersions){const d=u.pathname.split('/')[3],old=(99).toString(16).padStart(64,'0');return json([{digest:old,version:1,versions:2,is_latest:false,name:'Review file 01.txt',size:30,media_type:'text/plain',at:new Date(Date.now()-3600000).toISOString(),uploader:'Writer A',role:'Writer'},{digest:d,version:2,versions:2,is_latest:true,name:'Review file 01.txt',size:30,media_type:'text/plain',at:new Date().toISOString(),uploader:'Writer A',role:'Writer'}]);}
                        if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.endsWith('/comments')&&opts.method==='POST'){const b=JSON.parse(opts.body);window.__comments.push(b);return json({id:7,body:b.body,anchor:b.anchor,author_kind:'owner',author_name:'You',state:'open',created_at:new Date().toISOString(),replies:[]},201);}
                        if(u.pathname.startsWith('/api/artifacts/')&&u.pathname.endsWith('/comments/7/send')){const b=JSON.parse(opts.body);window.__comments.push({sent:b.agents});return json({ok:true,results:[{agent:b.agents[0],state:'sent',ask_id:1}]});}
                        if(u.pathname.startsWith('/api/board/${team}/artifacts/')&&u.pathname.endsWith('/tags')){
                            if(window.__reviewFail)return json({error:'Review save failed'},500);
                            const id=u.pathname.split('/').at(-2),body=JSON.parse(opts.body);window.__reviewWrites.push(body);
                            window.__reviewItems.find(a=>a.id===id).tags=body.tags;return json({tags:body.tags});
                        }
                        if(u.pathname.startsWith('/api/artifacts/')&&/^[0-9a-f]{64}$/.test(u.pathname.split('/')[3])&&(u.pathname.split('/').length===4||u.pathname.split('/')[4]==='content'))return Promise.resolve(new Response('Review preview text',{headers:{'Content-Type':'text/plain'}}));
                        return original(url,opts);
                    };return true;
                })()`);
                await ev(`window.__reviewItems[1].starred = true; true`); // the server's list says it (ListTeamArtifacts sets starred from the artifact_stars table, the same field the Artifacts tab reads): a starred review artifact comes with starred: true, not set by hand on a row (#9834, QA Reviewer 2)
                await ev(`localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));window.switchNavTab('hub-inbox');true`); // read oldest first: with newest first a list over the page's 12 rows shows File 01 last, behind "more" (#11552)
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${row('Review file 01.txt')})`,'for-review artifact in Needs you',15000);
                assert.equal(await ev(`(${row('Review file 03.txt')}).querySelector('.inbox-review-version').textContent`),' · version 3','the Needs you row adds the version after the name, from the list (#11890): the name is the agent\'s, Coral numbers the versions');
                assert.equal(await ev(`(${row('Review file 03.txt')}).querySelector('.inbox-review-earlier')?.textContent||''`),'2 earlier versions','and says how many came before it, though none of them is still waiting');
                assert.equal(await ev(`(${row('Review file 01.txt')}).querySelector('.inbox-review-version').hidden`),true,'a file with one version says nothing');
                assert.deepEqual(await ev(`window.__versionCalls`),[],'no row asks the server for its version: 13 files, 0 requests (#11890)');
                assert.equal(await ev(`${rows}.length`),12,'ten from Writer A and two from Writer B');
                assert.match(await ev(`document.getElementById('group-table-view').textContent`),/1 more/,'overflow remains discoverable');
                assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`),'9+','all pending artifacts count: the pill reads 9+ past nine (#9821)');
                assert.match(await ev(`document.getElementById('nav-tab-hub-inbox').getAttribute('aria-label')`),/^Inbox, 13 /,'and the tab\'s accessible name keeps the exact count');
                assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow');
                if (width <= 390) { // a phone's row (#11414 item 1, QA Engineer's release review): the team's whole name is on the row, and Approve is a word, not a bare check
                    const g = await ev(`(() => { const tr = ${row('Review file 01.txt')}, r = tr.getBoundingClientRect(), team = tr.querySelector('.inbox-review-team'), td = team && team.closest('td');
                        const ap = [...tr.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Approve')), tb = team && team.getBoundingClientRect(), db = td && td.getBoundingClientRect();
                        return { team: team ? team.textContent : null, teamWhole: !!team && tb.right <= db.right + 1 && tb.left >= db.left - 1 && team.scrollWidth <= team.clientWidth + 1, approve: ap ? ap.textContent.trim() : null, approveIn: !!ap && ap.getBoundingClientRect().right <= r.right + 1 }; })()`);
                    assert.equal(g.team, null, `${width}: the row does not name its team (it is in the opened file and the filters, #11719): ${JSON.stringify(g)}`);
                                        assert.equal(g.approve, 'Approve', `${width}: Approve is a word on the button, as on a desktop: ${JSON.stringify(g)}`);
                    assert.ok(g.approveIn, `${width}: and it is inside the row: ${JSON.stringify(g)}`);
                    assert.deepEqual(await ev(`[...(${row('Review file 01.txt')}).querySelectorAll('.inbox-review-actions button:not(.dt-star):not(.inbox-bookmark):not(.menu-item)')].map(b => (b.getAttribute('aria-label') || b.textContent).trim())`), ['Approve: Review file 01.txt', 'Request changes: Review file 01.txt', 'More actions for Review file 01.txt'], `${width}: an unread phone row has Approve, Changes and More (Deny and Ignore are in it), the row itself opens the file (#11552)`);
                }
                if (width > 390) { // column sizing (#9846): an empty column is not drawn, Item has room, Actions is whole, the table fits its box
                    const cols = await ev(`(() => { const box = document.querySelector('#group-table-view .dt-box'), br = box.getBoundingClientRect(), shown = e => !!e && getComputedStyle(e).display !== 'none'; const ch = (() => { const td = box.querySelector('tbody tr.dt-row td.dt-td'), s = document.createElement('span'); s.style.cssText = 'position:absolute;visibility:hidden;width:1ch;font:inherit'; td.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; })(); const heads = [...box.querySelectorAll('thead th.dt-th')].filter(shown).map(th => th.dataset.key + ':' + Math.round(th.getBoundingClientRect().width)); const row = box.querySelector('tbody tr.dt-row'), cell = k => row.querySelector('td[data-key="' + k + '"]'), r = e => e.getBoundingClientRect(); return { heads, itemCh: Math.round(r(cell('agent')).width / ch), goalCh: cell('goal') && shown(cell('goal')) ? Math.round(r(cell('goal')).width / ch) : 0, actionsRight: Math.round(r(cell('review')).right), boxRight: Math.round(br.right), actionsLeft: Math.round(r(cell('review')).left), fits: box.scrollWidth <= box.clientWidth + 1, scroll: box.scrollWidth, client: box.clientWidth, ch }; })()`);
                    assert.ok(!cols.heads.some(h => /^(cli|folder):/.test(h)), `${width}: CLI and Folder are empty on every review row and are not drawn: ` + JSON.stringify(cols.heads));
                    assert.ok(cols.itemCh >= 24, `${width}: Item has at least 24 characters of room: ` + JSON.stringify(cols));
                    assert.ok(!cols.heads.some(h => /^(goal|asks|team):/.test(h)), `${width}: Goal, Waiting for and Team are not on a review row (its why is the two lines under the name, #11719): ` + JSON.stringify(cols.heads));
                    assert.ok(cols.actionsRight <= cols.boxRight + 1 && cols.fits, `${width}: Actions is whole inside the table box and the box does not scroll: ` + JSON.stringify(cols));
                    if (width === 1280) { // the order columns go in when the box is tight (design rule 5): Waiting for first, then Goal, never Actions or the name; and an agent row brings CLI and Folder back
                        const headsAt = async (w) => { await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the box resizes and the table measures itself again
                            return ev(`(() => { const box = document.querySelector('#group-table-view .dt-box'), shown = e => !!e && getComputedStyle(e).display !== 'none'; return { heads: [...box.querySelectorAll('thead th.dt-th')].filter(shown).map(th => th.dataset.key), actionsInside: (() => { const a = box.querySelector('tbody tr.dt-row td[data-key="review"]'); return !!a && a.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1; })(), fits: box.scrollWidth <= box.clientWidth + 1 }; })()`); };
                        // The exact width at which Waiting for goes depends on how wide the Actions column is (Approve and a Request changes icon, #136584), so the order is checked over a sweep, not pinned at one width:
                        // Waiting for goes first, Goal never before it, the name and Actions never; everything fits at every width.
                        let seenAsksGone = false;
                        for (const w of [1280, 1180, 1120, 1060]) {
                            const h = await headsAt(w);
                            assert.ok(h.heads.includes('agent') && h.heads.includes('review') && h.actionsInside && h.fits, w + ': the name and Actions stay and fit: ' + JSON.stringify(h));
                            if (!h.heads.includes('asks')) seenAsksGone = true;
                            if (!h.heads.includes('goal')) assert.ok(!h.heads.includes('asks'), w + ': Goal goes only after Waiting for: ' + JSON.stringify(h));
                            if (seenAsksGone) assert.ok(!h.heads.includes('asks'), w + ': a column that went does not come back at a narrower width: ' + JSON.stringify(h));
                        }
                        const w1024 = await headsAt(1024);
                        assert.ok(!w1024.heads.includes('asks') && !w1024.heads.includes('goal') && w1024.heads.includes('agent') && w1024.heads.includes('review') && w1024.actionsInside && w1024.fits, '1024: Waiting for and Goal are gone, the name and Actions stay and fit: ' + JSON.stringify(w1024));
                        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: back to the width the rest of this pass reads
                        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'), m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = [{ name: 'agent-one', session_id: '00000001-0000-4000-8000-0000000000aa', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent One', working_directory: '/repo/alpha', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 300000).toISOString(), sleeping: false }]; m.updateInboxTab(); await m.selectInboxTab('needs'); return true; })()`);
                        await waitFor(`[...document.querySelectorAll('#group-table-view thead th.dt-th')].some(th => th.dataset.key === 'cli' && getComputedStyle(th).display !== 'none')`, '1280: one agent row brings the CLI column back', 8000);
                        const withAgent = await ev(`[...document.querySelectorAll('#group-table-view thead th.dt-th')].filter(th => getComputedStyle(th).display !== 'none').map(th => th.dataset.key)`);
                        assert.ok(withAgent.includes('cli') && withAgent.includes('review'), '1280: an agent row and the review rows together: CLI is drawn again and Actions stays: ' + JSON.stringify(withAgent));
                        // the table fits its panel (#11943): when the room is short Folder is the first to go (then Answer, then CLI), and a quiet control says so and brings it back
                        if (!withAgent.includes('folder')) {
                            const said = await ev(`(() => { const b = document.querySelector('#group-table-view .cols-hidden-btn'); return b && !b.closest('.cols-hidden-bar').hidden ? b.getAttribute('aria-label') : ''; })()`);
                            assert.ok(/Folder/.test(said), '1280: Folder is hidden to fit the panel and the control names it: ' + said);
                        }
                        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'), m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = []; m.updateInboxTab(); return true; })()`);
                    }
                    { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `needs-review-${width}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } } // the picture of the sizing
                }
                assert.equal(await ev(`document.querySelector('#group-table-view .inbox-folder-head .session-group-count').textContent`),'12 of 13','heading explains the cap');
                const names = await ev(`(() => {const r=${row('Review file 01.txt')},name=r.querySelector('.inbox-review-name');name.dispatchEvent(new Event('pointerenter'));return {cut:name.scrollWidth>name.clientWidth,title:name.title,text:name.textContent,open:name.getAttribute('aria-label')};})()`);
                assert.equal(names.title,names.cut?'Review file 01.txt':'','a cut filename keeps its full name in its tooltip, one that fits has none (#11566)');
                assert.equal(names.text,'Review file 01.txt','assistive text keeps the same full filename');
                assert.equal(names.open,'Open '+names.text,'the row\'s name button (it opens the file, there is no Open button) keeps the full filename');
                { const st = await ev(`(() => { const r = ${row('Review file 01.txt')}, b = r.querySelector('.inbox-review-actions .inbox-bookmark'); return { star: !!r.querySelector('.dt-star'), mark: b ? b.getAttribute('aria-label') : null }; })()`);
                  assert.ok(!st.star && (innerWidth_ => innerWidth_ >= 768 ? st.mark === 'Save for later: Review file 01.txt' : st.mark === null)(width), `${width}: a review row has no star; a wide one has the Save for later bookmark named for the file, a phone's is in its three dots (#11672): ` + JSON.stringify(st)); }
                // the star is not on a Needs you row any more (#11672): its slot is the Save for later bookmark; starring an artifact is in the Artifacts list (artifact_star_browser)
                const layout = await ev(`(() => {const r=${row('Review file 01.txt')}, buttons=[...r.querySelectorAll('.inbox-review-actions button:not(.dt-star):not(.inbox-bookmark)')], rects=buttons.map(b=>b.getBoundingClientRect());const team=r.querySelector('.inbox-review-team');return {actionsBesideName:rects[0].left>r.querySelector('.inbox-review-name').getBoundingClientRect().right-1&&Math.abs(rects[0].top+rects[0].height/2-(r.querySelector('.inbox-review-name').getBoundingClientRect().top+r.querySelector('.inbox-review-name').getBoundingClientRect().height/2))<2,team:team?team.textContent:null,height:r.getBoundingClientRect().height,sameLine:Math.abs(rects[0].top-rects[1].top)<2,standard:buttons.every(b=>!b.classList.contains('dt-quiet')&&!b.disabled)};})()`);
                assert.ok(layout.sameLine,'both actions stay on one line');
                assert.equal(layout.team,null,'the team is not on the row any more (#11719)');
                // #11671: a phone row has no button on screen (the actions stay in the page, out of sight), so there is no "beside the filename"; the 390 check is that none is shown
                if(width<=390)assert.ok(await ev(`(() => { document.activeElement?.blur?.(); const r = ${row('Review file 01.txt')}, c = r.querySelector('.inbox-review-actions').closest('.dt-td').getBoundingClientRect(); return c.width <= 2 || [...r.querySelectorAll('.inbox-review-actions button:not(.dt-star):not(.inbox-bookmark)')].every(b => b.getBoundingClientRect().width <= 2); })()`),'no action button is on screen on a phone row (a starred row keeps its star glyph)');
                assert.ok(layout.height<(width<=390?116:56),'compact review row (a phone row has the goal on its second line, #8917, so its waiting time may be a third): '+JSON.stringify(layout));
                assert.ok(layout.standard,'standard enabled button treatment');
                if(width<=390)assert.ok(await ev(`[...(${row('Review file 01.txt')}).querySelectorAll('.inbox-review-actions button:not(.dt-star):not(.inbox-bookmark):not(.menu-item)')].every(b=>b.getBoundingClientRect().height>=44)`),'review actions keep 44px touch targets');

                const dir=process.env.CORAL_SCREENSHOT_DIR||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'out'));
                if(dir){fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`);fs.writeFileSync(path.join(dir,`inbox-review-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
                await ev(`(${row('Review file 01.txt')}).querySelector('.inbox-review-name').click();true`);
                await waitFor(`document.body.textContent.includes('Review preview text')`,'artifact preview');
                assert.equal(await ev(`document.body.dataset.navTab`),'hub-inbox','preview keeps Inbox');
                // Close the shared viewer using its visible control, retaining the list.
                await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                // the viewer's review bar: a pending review shows Approve and Request changes; the row's own buttons are the same two (no Mark reviewed any more)
                assert.deepEqual(await ev(`[...(${row('Review file 01.txt')}).querySelectorAll('.inbox-review-actions button:not(.dt-star):not(.inbox-bookmark):not(.menu-item)')].map(b=>(b.getAttribute('aria-label')||b.textContent).trim())`),['Approve: Review file 01.txt','Request changes: Review file 01.txt','More actions for Review file 01.txt'],'a read row has Approve, Changes and More (Mark unread is in it) at these widths (#11552)');
                if(width===1280){
                    await ev(`(${row('Review file 01.txt')}).querySelector('.inbox-review-name').click();true`);
                    await waitFor(`!!document.querySelector('.artifact-review:not([hidden]) .artifact-review-approve:not([hidden])')`,'the viewer shows Approve for a pending review',8000);
                    assert.match(await ev(`document.querySelector('.artifact-review-state').textContent`),/Waiting for your review/);
                    await ev(`document.querySelector('.artifact-review-changes').click();true`);
                    await waitFor(`document.activeElement&&document.activeElement.id==='artifact-review-text'`,'the change request box has the focus',4000);
                    await ev(`(()=>{const t=document.getElementById('artifact-review-text');t.value='Please add the totals row';const f=document.querySelector('.artifact-review-form');f.requestSubmit();f.requestSubmit();return true;})()`); // a second tap while the first request is on its way (a phone: Mobile Beta Tester)
                    await waitFor(`window.__decisions.some(d=>d.decision==='changes')`,'the change request was recorded',8000);
                    const sent=await ev(`window.__comments`);
                    assert.equal(sent[0].anchor.whole,true,'a comment on the whole document'); assert.match(sent[0].body,/Please add the totals row/); assert.deepEqual(sent[1].sent,['Writer A'],'sent to the agent that uploaded it');
                    await waitFor(`/Changes requested/.test(document.querySelector('.artifact-review-state').textContent)`,'the state says Changes requested',8000);
                    assert.equal(await ev(`document.querySelector('.artifact-review-form').hidden`),true,'the request form is closed after it was sent: it does not stay open under Changes requested');
                    assert.equal(await ev(`document.querySelector('.artifact-review-approve').textContent`),'Approve anyway','after Changes requested Approve says it approves this version as it is (#11861)');
                    assert.match(await ev(`document.querySelector('.artifact-review-state').textContent`),/waiting for a new version from .*Approving now approves this version as it is/,'and the state says what is waited for');
                    assert.equal(await ev(`window.__decisions.filter(d=>d.decision==='changes').length`),1,'two taps sent one request');
                    assert.equal(await ev(`window.__comments.filter(c=>c.body).length`),1,'and made one comment');
                    assert.ok(await ev(`!!(${row('Review file 01.txt')})`),'a row with changes requested stays in Needs you');
                    // #11860 (Beta #8): the viewer reloads itself after the request, and that reload is not a new opening: the file is not marked read again, so it counts and shows unread
                    await require('./helpers/wait').settle(ev, 400, 300);
                    assert.equal(await ev(`window.__reviewItems.find(a=>a.id==='${(1).toString(16).padStart(64,'0')}').tags.includes('read')`),false,'Request changes leaves the file unread: the viewer reloading does not read it again: ' + await ev(`JSON.stringify(window.__reviewWrites)`));
                    assert.equal(await ev(`/, unread/.test((${row('Review file 01.txt')}).textContent)`),true,'and its row says unread');
                    await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                }
                await ev(`window.__reviewFail=true;[...(${row('Review file 01.txt')}).querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').startsWith('Approve')).click();true`);
                await waitFor(`document.body.textContent.includes('Review save failed')`,'failed save is visible');
                assert.ok(await ev(`!!(${row('Review file 01.txt')})`),'failed save keeps row');
                await ev(`window.__reviewFail=false;[...(${row('Review file 01.txt')}).querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').startsWith('Approve')).click();true`);
                await waitFor(`!(${row('Review file 01.txt')})`,'approved row removed');
                if(width===1280){ // Mobile Beta Tester (live): the approved artifact's viewer says Approved with the time (it showed only the tag chip)
                    await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m=>m.openArtifactViewer('${(1).toString(16).padStart(64,'0')}',{filename:'Review file 01.txt',board:'${team}',server:undefined}));true`);
                    await waitFor(`/^Approved .+/.test(document.querySelector('.artifact-review-state')?.textContent||'')`,'the viewer of an approved artifact says Approved with its time',8000);
                    assert.equal(await ev(`document.querySelector('.artifact-review-approve').hidden&&document.querySelector('.artifact-review-changes').hidden`),true,'and offers no Approve');
                    await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                    // the same for the newest of two versions (Mobile Beta Tester, live: the head of a two-version artifact had the versions bar and no approval line)
                    await ev(`window.__twoVersions=true;import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m=>m.openArtifactViewer('${(1).toString(16).padStart(64,'0')}',{filename:'Review file 01.txt',board:'${team}',server:undefined}));true`);
                    await waitFor(`!!document.querySelector('.artifact-viewer .av-compare, .artifact-viewer .av-current')`,'the versions bar of a two-version artifact',8000);
                    await new Promise(r=>setTimeout(r,800)); // sleep-ok: the version bar's own reload settles
                    assert.equal(await ev(`document.querySelector('.artifact-viewer-title').textContent`),'Review file 01.txt · version 2','the viewer title adds the version after the name (#11890)');
                    await waitFor(`/^Approved .+/.test(document.querySelector('.artifact-review-state')?.textContent||'')`,'the head of a two-version approved artifact says Approved with its time',8000);
                    const vis = await ev(`(() => { const b = document.querySelector('.artifact-review'), r = b.getBoundingClientRect(), cs = getComputedStyle(b); return { h: Math.round(r.height), w: Math.round(r.width), display: cs.display, hidden: b.hidden, parent: b.parentElement.className, prev: b.previousElementSibling?.className, next: b.nextElementSibling?.className }; })()`);
                    assert.ok(vis.h > 0 && vis.w > 0 && vis.display !== 'none', 'the review bar of a two-version artifact is on the screen: ' + JSON.stringify(vis));
                    await ev(`document.querySelector('.artifact-viewer-close').click();window.__twoVersions=false;true`);
                }
                assert.deepEqual(await ev(`window.__decisions.filter(d=>d.decision==='approve').map(d=>d.id)`),[(1).toString(16).padStart(64,'0')],'one approve was sent: the failed press and the second one are not two');
                assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`),'9+');
                assert.match(await ev(`document.getElementById('nav-tab-hub-inbox').getAttribute('aria-label')`),/^Inbox, 12 /,'twelve left: the pill says 9+, the name says 12');
                assert.ok(await ev(`!!(${row('Review file 11.txt')})`),'overflow promotes next artifact');
                assert.equal(await ev(`document.querySelector('#group-table-view .inbox-folder-head .session-group-count').textContent`),'12','heading and badge agree after review');
                if(dir){for(const theme of ['light','dark']){await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`);fs.writeFileSync(path.join(dir,`inbox-reviewed-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
                console.log('PASS review artifacts '+width);
            } catch(error){failures.push(width+': '+error.message);console.error(failures.at(-1));}
        }
        assert.equal(failures.length,0,failures.join('\n'));
    } finally {await removeBoards(ev,[team]).catch(()=>{});await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
