// #18701 (the Operator): a file sent back with Request changes shows a clear state in Needs you: a chip "Sent back · waiting on <agent>" (whole, in place of For review), no blue Approve as the main button, a line of what was asked, and a time that counts from the send-back, neutral not amber. A file still waiting for the Operator keeps all of it as before. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'sent-back-' + Date.now().toString(36), failures = [];
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
                    window.__reviewItems = [mk(1, 'Quiet file.txt', ['for review'], 0), mk(2, 'Sent back file.txt', ['for review', 'changes requested'], 0)]; window.__reviewItems[1].review = { state: 'changes requested', at: new Date(Date.now() - 5 * 60000).toISOString() }; window.__reviewItems[1].created_at = new Date(Date.now() - 3 * 3600000).toISOString();
                    window.__commentsFail = false; window.__tagReads = [];
                    const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (url, opts = {}) => {
                        const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': window.__reviewItems}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                        if (u.pathname === '/api/board/${team}/artifacts') {
                            const tag = u.searchParams.get('tag'); window.__tagReads.push(tag);
                            const items = window.__reviewItems.filter(a => !tag || a.tags.includes(tag) || (tag === 'for review' && a.new_comments > 0 && /approved|denied/.test(a.tags.join(' ')) && !a.tags.some(x => ['saved', 'ignored', 'superseded'].includes(x)))); // the server's rule (#12097): the for-review list also holds a decided file with news
                            return json({ project: '${team}', artifacts: items, has_more: false });
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
                const tab = key => ev(`document.querySelector('[data-needs-tab="${key}"]').click(); true`); // the two tabs of Needs you (#19904): the sent-back file is on Waiting on an agent
                const info = name => ev(`(() => { const r = ${row(name)}, chip = r.querySelector('.inbox-sent-back'), ask = r.querySelector('.inbox-sent-back-ask'), ap = r.querySelector('[data-slot=approve]'), age = r.querySelector('.inbox-age'); return { chip: chip ? chip.textContent : null, chipWhole: chip ? chip.scrollWidth <= chip.clientWidth + 1 : null, ask: ask && !ask.hidden ? ask.textContent : null, forReview: [...r.querySelectorAll('.inbox-kind')].some(k => /For review/.test(k.textContent)), primary: ap ? ap.classList.contains('btn-primary') : null, age: age ? age.className + '|' + age.textContent : null, slow: /changes requested/i.test(r.querySelector('.inbox-review-name')?.textContent || '') }; })()`);
                await waitFor(`!!(${row('Quiet file.txt')})`, 'the file waiting for the Operator is on Waiting on you', 15000);
                assert.equal(await ev(`!${row('Sent back file.txt')}`), true, 'and the sent-back file is not on that tab');
                const quiet = await info('Quiet file.txt'); // read while its tab is open
                await tab('agent'); await waitFor(`!!(${row('Sent back file.txt')})&&!${row('Quiet file.txt')}`, 'the sent-back file is on Waiting on an agent, the other is not', 15000);
                await waitFor(`(${row('Sent back file.txt')}).querySelector('.inbox-sent-back-ask') && !(${row('Sent back file.txt')}).querySelector('.inbox-sent-back-ask').hidden`, 'the request is read from the thread', 8000);
                const sent = await info('Sent back file.txt');
                assert.match(sent.chip || '', /^Sent back$/, 'the chip names the state: ' + JSON.stringify(sent)); assert.equal(await ev(`/Waiting on Writer A/.test((${row('Sent back file.txt')}).textContent)`), true, 'and the meta line names the agent: Waiting on Writer A');
                assert.ok(sent.chipWhole, 'and is not cut off');
                assert.ok(width !== 1280 || !sent.forReview, 'the row no longer says For review in its line: ' + JSON.stringify(sent));
                assert.notEqual(sent.primary, true, 'Approve is not the blue main button on a sent-back row (on Waiting on an agent it has no Approve at all, #19904)');
                assert.match(sent.ask || '', /^You asked: “please add a summary table at the top.*”$/, 'one line of what was asked for, as You asked: “...” (mock v3, #20101), without the Changes requested: prefix: ' + JSON.stringify(sent));
                assert.ok(!sent.slow, 'the grey Changes requested text after the title is gone (the chip says it)');
                if (width === 1280) assert.ok(/inbox-age$/.test((sent.age || '').split('|')[0]) && /5 min|under 1 min/.test(sent.age), 'the time counts from the send-back (5 min), neutral, not amber for the 3 h upload: ' + sent.age);
                assert.equal(quiet.chip, null, 'a file still waiting for the Operator has no chip'); assert.ok((width !== 1280 || quiet.forReview) && quiet.primary === false, 'and keeps For review and a Default Approve (#17450): ' + JSON.stringify(quiet));
                // a new version: the agent uploads again and the row is back to needing review as before
                await ev(`(() => { const it = window.__reviewItems[1]; it.tags = ['for review']; delete it.review; return import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true); })()`);
                await waitFor(`!${row('Sent back file.txt')}`, 'the row leaves Waiting on an agent when the tag goes'); await tab('you'); await waitFor(`!!${row('Sent back file.txt')} && !(${row('Sent back file.txt')}).querySelector('.inbox-sent-back')`, 'and is on Waiting on you without the chip');
                const back = await info('Sent back file.txt'); assert.ok((width !== 1280 || back.forReview) && back.primary === false, 'back to needing review with a Default Approve: ' + JSON.stringify(back));
                console.log('PASS sent-back state ' + width);
            } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
