// #20735 (the approved mock, option A): a plain comment keeps the file in For review: its row says 'You commented ..., waiting for <agent>' and is quieter, and it is NOT listed under Waiting on an agent (that is for Request changes and Wait for agent). The line goes when the agent replies or the file has a new version. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'comment-row-' + Date.now().toString(36), failures = [];
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
                    window.__reviewItems = [mk(1, 'Quiet file.txt', ['for review'], 0), mk(5, 'Commented file.txt', ['for review'], 0), sb(2, 'Awake file.txt', 'sess-awake', 'Writer A')];
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
                const hexOf = i => i.toString(16).padStart(64, '0');
                const W = `import((window.__coralStatic||'/static/')+'inbox_waiting_agent.js')`;
                const setWaiting = items => ev(`(async()=>{window.__waiting=${JSON.stringify(items)};const W=await ${W};await W.load({force:true});await W.load({force:true});return true;})()`);
                const said = name => ev(`(${row(name)}) && [...(${row(name)}).querySelectorAll('.inbox-commented')].map(e => e.textContent.trim())`);
                await waitFor(`!!(${row('Commented file.txt')})`, 'the commented file is a row');
                check(JSON.stringify(await said('Commented file.txt')) === '[]', 'a file with no comment from you has no You commented line');
                // 1. the Operator comments on a file sent for review: the row says so
                const item = { kind: 'comment_sent', id: 'cmt-' + width, board: team, agent: { name: 'Writer A', session_id: 'writer-a' }, since: new Date(Date.now() - 2 * 60000).toISOString(), operator_words: 'Tighten the intro.', artifact: { hex: hexOf(5), name: 'Commented file.txt' }, thread_id: 1 };
                await setWaiting([item]);
                if (process.env.CORAL_SCREENSHOT_DIR) { await new Promise(r => setTimeout(r, 900)); /* sleep-ok: let the list draw for the screenshot */ for (const theme of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`); await new Promise(r => setTimeout(r, 250)); /* sleep-ok: theme repaint */ require('fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('fs').writeFileSync(require('path').join(process.env.CORAL_SCREENSHOT_DIR, `comment-row-${process.env.CORAL_SHOT_TAG || 'after'}-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
                await waitFor(`!!(${row('Commented file.txt')}) && (${row('Commented file.txt')}).querySelector('.inbox-commented')`, 'the row says You commented');
                const line = await said('Commented file.txt');
                check(line.length === 1 && /^You commented 2 min ago, waiting for Writer A$/.test(line[0]), 'the line reads You commented 2 min ago, waiting for Writer A: ' + JSON.stringify(line));
                check(await ev(`!!(${row('Commented file.txt')}).querySelector('.inbox-review-item[data-commented]')`), 'the row is marked commented (quieter)');
                check(JSON.stringify(await said('Quiet file.txt')) === '[]', 'another file has no line');
                check(await ev(`!![...(${row('Commented file.txt')}).querySelectorAll('button')].find(b => /^Approve$/.test(b.textContent.trim()))`), 'Approve is still on the row');
                check(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), 'no horizontal overflow');
                check(JSON.stringify(await ev(`[...(${row('Commented file.txt')}).querySelectorAll('.inbox-commented-quote')].map(e => e.textContent.trim())`)) === JSON.stringify(['\u201cTighten the intro.\u201d']), 'the row quotes your comment');
                check(await ev(`!![...(${row('Commented file.txt')}).querySelectorAll('button')].find(b => /^Approve$/.test(b.textContent.trim()) && b.classList.contains('btn-quiet'))`), 'Approve is quiet on a commented row');
                check(await ev(`!![...(${row('Quiet file.txt')}).querySelectorAll('button')].find(b => /^Approve$/.test(b.textContent.trim()) && !b.classList.contains('btn-quiet'))`), 'Approve stays normal on another row');
                // 1b. the agent replies with a new comment: the line goes at once, even while the server still lists your comment
                await ev(`(async()=>{window.__reviewItems.find(a=>a.name==='Commented file.txt').new_comments=1;await (await import((window.__coralStatic||'/static/')+'inbox_reviews.js')).refreshReviews(true);return true;})()`);
                await waitFor(`!!(${row('Commented file.txt')}) && !(${row('Commented file.txt')}).querySelector('.inbox-commented, .inbox-commented-quote')`, 'a new comment from the agent takes the You commented line away');
                await ev(`(async()=>{window.__reviewItems.find(a=>a.name==='Commented file.txt').new_comments=0;await (await import((window.__coralStatic||'/static/')+'inbox_reviews.js')).refreshReviews(true);return true;})()`);
                await waitFor(`!!(${row('Commented file.txt')}).querySelector('.inbox-commented')`, 'the line is back once the new comment is read');
                // 2. it is not under Waiting on an agent
                await ev(`document.querySelector('[data-needs-tab="agent"]').click(); true`);
                await waitFor(`!!(${row('Awake file.txt')})`, 'Waiting on an agent shows the sent-back file');
                check(await ev(`!(${row('Commented file.txt')})`), 'a plain comment is not a row of Waiting on an agent');
                check(!/Comment sent/.test(await ev(`document.getElementById('group-table-view').innerText`)), 'no Comment sent chip');
                // 2b. a plain comment with no For review row (a goal thread, a file not in For review) is not lost: it stays under Waiting on an agent
                const goalItem = { kind: 'comment_sent', id: 'cmt-goal-' + width, board: team, agent: { name: 'Writer A', session_id: 'writer-a' }, since: new Date(Date.now() - 3 * 60000).toISOString(), operator_words: 'Narrow the goal.', goal: { id: 7, title: 'Orphan goal' }, thread_id: 2 };
                const strayItem = { ...goalItem, id: 'cmt-stray-' + width, goal: null, artifact: { hex: hexOf(99), name: 'Stray file.txt' }, thread_id: 3 };
                await setWaiting([item, goalItem, strayItem]);
                await waitFor(`!!(${row('Orphan goal')}) && !!(${row('Stray file.txt')})`, 'a comment with no For review row stays in Waiting on an agent');
                check(await ev(`!(${row('Commented file.txt')})`), 'a comment shown on its For review row is still not in Waiting on an agent');
                await ev(`document.querySelector('[data-needs-tab="you"]').click(); true`);
                // 3. the agent replies: the server drops the item and the row is plain again
                await setWaiting([]);
                await waitFor(`!!(${row('Commented file.txt')}) && !(${row('Commented file.txt')}).querySelector('.inbox-commented')`, 'the line goes when the agent has answered');
            } catch (e) { failures.push(width + ': ' + (e.stack || e)); }
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a comment keeps the file in For review with a You commented line, not in Waiting on an agent');
})().catch(e => { console.error(e); process.exit(1); });
