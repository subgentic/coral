// #19904 (the approved two-tab mock): Needs you has two tabs. Waiting on you (default) holds what waits on the Operator; Waiting on an agent holds the files the Operator sent back, each with its agent's state (Awake, Asleep, Archived), Wake for an asleep one and Start agent for an archived one, and the quiet actions in place of Approve / Request changes. Only the first tab is counted in the badge. 1280 and 390, light and dark.
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
                    const sb = (i, name, sid, who) => ({ ...mk(i, name, ['for review', 'changes requested'], 0), session_id: sid, produced_by: who, review: { state: 'changes requested', at: new Date(Date.now() - i * 60000).toISOString() } });
                    window.__reviewItems = [mk(1, 'Quiet file.txt', ['for review'], 0), sb(2, 'Awake file.txt', 'sess-awake', 'Writer A'), sb(3, 'Asleep file.txt', 'sess-asleep', 'Writer B'), sb(4, 'Archived file.txt', 'sess-archived', 'Writer C')];
                    import((window.__coralStatic || '/static/') + 'state.js').then(m => { const live = (id, n, extra) => ({ session_id: id, name: n, display_name: n, agent_type: 'claude', working: false, ...extra }); m.state.liveSessions = [live('sess-awake', 'Writer A', {}), live('sess-asleep', 'Writer B', { sleeping: true }), live('sess-archived', 'Writer C', { archived: true, sleeping: true })]; });
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

                await waitFor(`!!(${row('Quiet file.txt')})`, 'the quiet file is on Waiting on you', 15000);
                const tabs = () => ev(`[...document.querySelectorAll('.inbox-needs-tab')].map(b => ({ key: b.dataset.needsTab, text: b.firstChild.textContent, n: b.querySelector('.inbox-needs-tab-count').textContent, on: b.getAttribute('aria-selected') === 'true', dot: !!b.querySelector('.inbox-needs-tab-dot') }))`);
                const t0 = await tabs();
                assert.deepEqual(t0.map(t => [t.key, t.text, t.n, t.on]), [['you', 'Waiting on you', '1', true], ['agent', 'Waiting on an agent', '3', false]], 'two tabs, the first on, each with its count: ' + JSON.stringify(t0));
                assert.equal(t0[1].dot, true, 'the amber dot says an asleep or archived agent is among them');
                assert.equal(await ev(`!${row('Awake file.txt')} && !document.querySelector('.inbox-needs-results .dt-group')`), true, 'no sent-back file and no divider on Waiting on you');
                assert.equal(await badge(), '1', 'the badge counts only Waiting on you');
                const shot = async (name) => { if (!process.env.CORAL_SCREENSHOT_DIR) return; for (const theme of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`); await new Promise(r => setTimeout(r, 250)); require('fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('fs').writeFileSync(require('path').join(process.env.CORAL_SCREENSHOT_DIR, `two-tabs-${name}-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
                await shot('you');
                await ev(`document.querySelector('[data-needs-tab="agent"]').click(); true`);
                await waitFor(`!!(${row('Awake file.txt')}) && !${row('Quiet file.txt')}`, 'the sent-back files are on Waiting on an agent', 8000);
                assert.equal(await ev(`!document.querySelector('.inbox-needs-results .dt-group')`), true, 'with no divider heading');
                const rowsInfo = name => ev(`(() => { const r = ${row(name)}; const b = [...r.querySelectorAll('.inbox-review-actions button')].map(x => x.textContent.trim()); return { state: (r.querySelector('.inbox-wait-state') || {}).textContent || '', line: (r.querySelector('.inbox-wait-line') || {}).textContent || '', buttons: b, chip: !!r.querySelector('.inbox-sent-back') }; })()`);
                const a1 = await rowsInfo('Awake file.txt'), a2 = await rowsInfo('Asleep file.txt'), a3 = await rowsInfo('Archived file.txt');
                assert.equal(a1.state, 'Awake'); assert.equal(a2.state, 'Asleep'); assert.equal(a3.state, 'Archived');
                assert.match(a2.line, /Writer B is asleep .* won.t read your changes request until woken/); assert.match(a3.line, /Writer C is archived .* don.t wake automatically/);
                assert.ok(a1.chip && !a1.line, 'an awake agent has the chip and no warning line: ' + JSON.stringify(a1));
                assert.ok(!a1.buttons.includes('Wake') && !a1.buttons.includes('Start agent'), 'an awake agent has no Wake: ' + JSON.stringify(a1));
                assert.ok(a2.buttons.includes('Wake') && !a2.buttons.includes('Start agent'), 'an asleep agent has Wake: ' + JSON.stringify(a2));
                assert.ok(a3.buttons.includes('Start agent') && !a3.buttons.includes('Wake'), 'an archived agent has Start agent: ' + JSON.stringify(a3));
                for (const x of [a1, a2, a3]) assert.ok(x.buttons.includes('Open file') && !x.buttons.includes('Approve') && !x.buttons.includes('Request changes'), 'quiet actions, no Approve or Request changes: ' + JSON.stringify(x));
                const pills = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`);
                assert.ok(pills.some(t => /^All 3/.test(t)) && pills.some(t => /^Sent back 3/.test(t)) && !pills.some(t => /Permission|Question/.test(t)), 'the kind pills of this tab: All, Sent back: ' + JSON.stringify(pills));
                await shot('agent');
                // Wake wakes the agent
                await ev(`window.__woke = []; const o = window.fetch; window.fetch = (u, opts) => { if (/\\/wake$|\\/unarchive$/.test(String(u))) { window.__woke.push(String(u)); return Promise.resolve(new Response(JSON.stringify({ ok: true, sleeping: false, archived: false }), { headers: { 'Content-Type': 'application/json' } })); } return o(u, opts); }; true`);
                await ev(`[...(${row('Asleep file.txt')}).querySelectorAll('.inbox-review-actions button')].find(b => b.textContent === 'Wake').click(); true`);
                await waitFor(`window.__woke.some(u => /sess-asleep\\/wake$/.test(u))`, 'Wake asks the server to wake that agent', 8000);
                // nothing waiting on an agent: the empty state
                await ev(`window.__reviewItems = window.__reviewItems.filter(a => !a.tags.includes('changes requested')); import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
                await waitFor(`/Nothing waiting on an agent/.test(document.getElementById('group-table-view').innerText)`, 'the empty state of the second tab', 8000);
                assert.match(await ev(`document.getElementById('group-table-view').innerText`), /Open Activity/, 'with its way on: Open Activity');
                await shot('agent-empty');
                await ev(`document.querySelector('[data-needs-tab="you"]').click(); true`);
                console.log('PASS two tabs ' + width);
            } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
