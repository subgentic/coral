// #19904 (the approved two-tab mock): Needs you has two tabs. Waiting on you (default) holds what waits on the Operator; Waiting on an agent holds the files the Operator sent back, each with its agent's state (Awake, Asleep, Archived), Wake for an asleep one and Start agent for an archived one, and the quiet actions in place of Approve / Request changes. Only the first tab is counted in the badge. 1280 and 390, light and dark.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'controls-sendback-' + Date.now().toString(36), failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    const badge = () => ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`);
    const marker = name => ev(`!![...(${row(name)}).querySelectorAll('.inbox-new-comments')].find(t => /[1-9][0-9]* new comments?/.test(t.textContent))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
                await ev(`(() => {
                    localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral-inbox-needs-tab');
                    const style = document.createElement('style'); style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.append(style);
                    window.__commentReads = [];
                    const mk = (i, name, tags, news) => ({ id: i.toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - i) * 60000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'writer-a', produced_by: 'Writer A', tags, ...(news ? { new_comments: news } : {}) });
                    const sb = (i, name, sid, who) => ({ ...mk(i, name, ['for review', 'changes requested'], 0), session_id: sid, produced_by: who, review: { state: 'changes requested', at: new Date(Date.now() - i * 60000).toISOString() } });
                    window.__reviewItems = [mk(1, 'Quiet file.txt', ['for review'], 0), sb(2, 'Awake file.txt', 'sess-awake', 'Writer A'), sb(3, 'Asleep file.txt', 'sess-asleep', 'Writer B'), sb(4, 'Archived file.txt', 'sess-archived', 'Writer C')];
                    import((window.__coralStatic || '/static/') + 'state.js').then(m => { const live = (id, n, extra) => ({ session_id: id, name: n, display_name: n, agent_type: 'claude', working: false, board_project: '${team}', ...extra }); m.state.liveSessions = [live('sess-awake', 'Writer A', {}), live('sess-asleep', 'Writer B', { sleeping: true }), live('sess-archived', 'Writer C', { archived: true, sleeping: true })]; });
                    window.__commentsFail = false; window.__tagReads = [];
                    const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (url, opts = {}) => {
                        const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': window.__reviewItems}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                        if (u.pathname === '/api/settings' && opts.method === 'PUT') return json({ ok: true }); // the page's own settings saves (Getting started's done list) never reach the server, so no run leaves a setting changed
                        if (u.pathname === '/api/waiting-on-agent') return window.__waitingFail ? json({ error: 'not available' }, 500) : json({ items: (window.__waiting || []) });
                        if (u.pathname === '/api/board/${team}/artifacts') {
                            const tag = u.searchParams.get('tag'); window.__tagReads.push(tag);
                            const items = window.__reviewItems.filter(a => !tag || a.tags.includes(tag) || (tag === 'for review' && a.new_comments > 0 && /approved|denied/.test(a.tags.join(' ')) && !a.tags.some(x => ['saved', 'ignored', 'superseded'].includes(x)))); // the server's rule (#12097): the for-review list also holds a decided file with news
                            return json({ project: '${team}', artifacts: items, has_more: false });
                        }
                        if (u.pathname.startsWith('/api/board/${team}/artifacts/') && u.pathname.endsWith('/review')) {
                            const it=window.__reviewItems.find(a=>a.id===u.pathname.split('/').at(-2));it.tags=it.tags.filter(t=>t!=='for review').concat('ignored');return json({ok:true});
                        }
                        if (u.pathname.startsWith('/api/board/${team}/artifacts/') && u.pathname.endsWith('/tags')) {
                            const id = u.pathname.split('/').at(-2), body = JSON.parse(opts.body);
                            window.__reviewItems.find(a => a.id === id).tags = body.tags; return json({ tags: body.tags });
                        }
                        const parts = u.pathname.split('/');
                        if (parts[1] === 'api' && parts[2] === 'artifacts' && /^[0-9a-f]{64}$/.test(parts[3]) && parts[4] === 'comments' && !parts[5]) { // the Operator reading the thread: the server marks it seen
                            if (window.__commentsFail) return json({ error: 'down' }, 500);
                            window.__commentReads.push(parts[3]);
                            const it = window.__reviewItems.find(a => a.id === parts[3]); if (it) delete it.new_comments;
                            return json({ comments: parts[3] === (2).toString(16).padStart(64, '0') ? [{ id: 7, parent_id: null, anchor: { whole: true }, body: 'Changes requested: please add a summary table at the top and fix the date in section 2', mine: true, author: { kind: 'owner', name: 'You' }, created_at: new Date().toISOString() }] : [], you: { kind: 'owner', can_comment: true, can_lock: true }, locked: false });
                        }
                        if (parts[1] === 'api' && parts[2] === 'artifacts' && /^[0-9a-f]{64}$/.test(parts[3]) && (parts.length === 4 || parts[4] === 'content')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                        return original(url, opts);
                    }; return true;
                })()`);
                await ev(`window.switchNavTab('hub-inbox');true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);

                await waitFor(`!!(${row('Quiet file.txt')})`, 'the quiet file is on Waiting on you', 15000);
                const check = (ok, why) => { if (!ok) failures.push(width + ': ' + why); };
                check(await ev(`document.querySelector('.inbox-folder-toolbar input[type=search]').placeholder === 'Search waiting on you'`), 'item 3: search says Search waiting on you');
                const kinds = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].map(b=>b.textContent.trim().replace(/\\s+/g,' '))`);
                check(JSON.stringify(kinds) === JSON.stringify(['All 1','For review 1','Permission 0','Question 0','Goal looks done 0']), 'item 4: mock kind order, no empty Needs input: '+JSON.stringify(kinds));
                await ev(`(async()=>{window.__waiting=[{kind:'comment_sent',id:${713+width},board:'${team}',agent:{name:'Writer A',session_id:'sess-awake'},since:new Date().toISOString(),operator_words:'Please add a summary table.',artifact:{hex:(2).toString(16).padStart(64,'0'),name:'Awake file.txt'},thread_id:713}];const W=await import((window.__coralStatic||'/static/')+'inbox_waiting_agent.js');await W.load({force:true});document.querySelector('[data-needs-tab="agent"]').click();})()`);
                await waitFor(`!!(${row('Awake file.txt')})`, 'sent-back file before stopping');
                check(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].filter(r=>r.textContent.includes('Awake file.txt')).length === 1`), 'item 8: request-changes comment initially shares its file row');
                await ev(`(${row('Awake file.txt')}).querySelector('[aria-label^="More actions for"]').click()`);
                await waitFor(`[...document.querySelectorAll('.inbox-row-more [role=menuitem]')].some(b=>b.getClientRects().length && b.textContent.trim()==='Stop waiting')`, 'Stop waiting menu');
                await ev(`[...document.querySelectorAll('.inbox-row-more [role=menuitem]')].find(b=>b.getClientRects().length && b.textContent.trim()==='Stop waiting').click()`);
                await waitFor(`window.__reviewItems.find(a=>a.name==='Awake file.txt').tags.includes('ignored')`, 'file ignored by the server');
                await ev(`(async()=>{await (await import((window.__coralStatic||'/static/')+'inbox_reviews.js')).refreshReviews(true);})()`);
                check(await ev(`!(${row('Awake file.txt')})`), 'item 8: one Stop waiting removes file and matching request-changes comment');
                await ev(`(async()=>{await (await import((window.__coralStatic||'/static/')+'inbox_waiting_agent.js')).load({force:true});})()`);
                check(await ev(`!(${row('Awake file.txt')})`), 'item 8: refresh does not reveal the same comment');
                const waiting = await ev(`window.__waiting`);
                await Page.reload(); await Page.loadEventFired(); await install(); await coralReady(ev);
                await ev(`(()=>{const real=window.fetch,items=${JSON.stringify(waiting)};window.fetch=(u,o)=>new URL(String(u),location.href).pathname==='/api/waiting-on-agent'?Promise.resolve(Response.json({items})):real(u,o);})()`);
                check(await ev(`(async()=>{const W=await import((window.__coralStatic||'/static/')+'inbox_waiting_agent.js');await W.load({force:true});return !W.rows().some(r=>r.waitItem.id===${713+width});})()`), 'item 8: actual page reload keeps the same comment dismissed');

            } catch (e) { failures.push(width + ': ' + (e.stack || e)); }
        }
    } finally { await removeBoards(ev,[team]).catch(()=>{});await client.close(); }
    if(failures.length)throw new Error(failures.join('\n'));
    console.log('PASS mock search, kind order, and single-click Stop waiting at desktop/phone widths');
})().catch(e=>{console.error(e);process.exit(1);});
