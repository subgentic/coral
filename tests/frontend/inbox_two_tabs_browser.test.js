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
                    import((window.__coralStatic || '/static/') + 'state.js').then(m => { const live = (id, n, extra) => ({ session_id: id, name: n, display_name: n, agent_type: 'claude', working: false, board_project: '${team}', ...extra }); m.state.liveSessions = [live('sess-awake', 'Writer A', {}), live('sess-asleep', 'Writer B', { sleeping: true }), live('sess-archived', 'Writer C', { archived: true, sleeping: true })]; });
                    window.__commentsFail = false; window.__tagReads = [];
                    const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (url, opts = {}) => {
                        const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': window.__reviewItems}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                        if (u.pathname === '/api/waiting-on-agent') return window.__waitingFail ? json({ error: 'not available' }, 500) : json({ items: (window.__waiting || []) });
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
                const badgeBefore = await badge();
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
                // the sentence of an inactive agent is whole: nothing cut, on the phone too (the mock's 390 row)
                const whole = await ev(`(() => { const l = (${row('Asleep file.txt')}).querySelector('.inbox-wait-line'), r = l.getBoundingClientRect(), card = l.closest('.dt-row, tr').getBoundingClientRect(); return { fits: l.scrollWidth <= l.clientWidth + 1 && l.scrollHeight <= l.clientHeight + 1, inside: r.left >= card.left - 1 && r.right <= card.right + 1, wraps: getComputedStyle(l).whiteSpace, text: l.textContent }; })()`);
                assert.ok(whole.fits && whole.inside && whole.wraps === 'normal', 'the asleep agent’s whole sentence shows, inside the row: ' + JSON.stringify(whole));
                // More: an awake agent can be nudged or given another note; an asleep or archived one is dealt with on the board
                const menuOf = name => ev(`(async () => { const t = (${row(name)}).querySelector('[aria-label^="More actions for"]'); t.click(); await new Promise(x => setTimeout(x, 250)); const m = [...document.querySelectorAll('.inbox-row-more .menu:not([hidden]) [role=menuitem]')].map(b => b.textContent.trim()); t.click(); await new Promise(x => setTimeout(x, 150)); return m; })()`);
                const m1 = await menuOf('Awake file.txt'), m2 = await menuOf('Asleep file.txt'), m3 = await menuOf('Archived file.txt');
                assert.deepEqual(m1.filter(t => /Nudge|note|board|anyway|Stop/.test(t)), ['Nudge Writer A', 'Add another note', 'Approve anyway', 'Stop waiting'], 'awake: Nudge and Add another note, then Approve anyway and Stop waiting: ' + JSON.stringify(m1));
                assert.deepEqual(m2.filter(t => /Nudge|note|board|anyway|Stop/.test(t)), ['Reassign on board', 'Approve anyway', 'Stop waiting'], 'asleep: Reassign on board: ' + JSON.stringify(m2));
                assert.deepEqual(m3.filter(t => /Nudge|note|board|anyway|Stop/.test(t)), ['Hand off on board', 'Approve anyway', 'Stop waiting'], 'archived: Hand off on board: ' + JSON.stringify(m3));
                // the Filters panel of this tab: Agent state and Group by Agent (the other tab has neither)
                assert.equal(await ev(`!!document.querySelector('.inbox-agent-state-field select') && !!document.querySelector('.inbox-agent-group-field select') && (document.querySelector('.inbox-group-review-toggle') || { hidden: true }).hidden`), true, 'the panel has Agent state and its own Group by');
                await ev(`(() => { const s = document.querySelector('.inbox-agent-state-field select'); s.value = 'asleep'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`!!(${row('Asleep file.txt')}) && !(${row('Awake file.txt')}) && !(${row('Archived file.txt')})`, 'Agent state: Asleep shows only the asleep agent’s file', 8000);
                assert.match(await ev(`document.querySelector('[data-needs-tab="agent"]').textContent`), /3/, 'the tab still counts all three');
                await ev(`(() => { const s = document.querySelector('.inbox-agent-state-field select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`!!(${row('Awake file.txt')}) && !!(${row('Archived file.txt')})`, 'All shows them again', 8000);
                await ev(`(() => { const s = document.querySelector('.inbox-agent-group-field select'); s.value = 'agent'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`document.querySelectorAll('.inbox-needs-results .dt-group').length === 3`, 'Group by Agent: a heading for each of the three agents', 8000);
                const heads = await ev(`[...document.querySelectorAll('.inbox-needs-results .dt-group')].map(g => g.textContent.replace(/\\s+/g, ' ').trim())`);
                assert.ok(heads.some(t => /Writer A · Awake/.test(t)) && heads.some(t => /Writer B · Asleep/.test(t)) && heads.some(t => /Writer C · Archived/.test(t)), 'each heading names the agent and its state: ' + JSON.stringify(heads));
                await shot('agent-grouped');
                await ev(`(() => { const s = document.querySelector('.inbox-agent-group-field select'); s.value = 'none'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`!document.querySelector('.inbox-needs-results .dt-group')`, 'None takes the headings away', 8000);
                await shot('agent');
                // Wake wakes the agent
                await ev(`window.__woke = []; const o = window.fetch; window.fetch = (u, opts) => { if (/\\/wake$|\\/unarchive$/.test(String(u))) { window.__woke.push(String(u)); return Promise.resolve(new Response(JSON.stringify({ ok: true, sleeping: false, archived: false }), { headers: { 'Content-Type': 'application/json' } })); } return o(u, opts); }; true`);
                await ev(`[...(${row('Asleep file.txt')}).querySelectorAll('.inbox-review-actions button')].find(b => b.textContent === 'Wake').click(); true`);
                await waitFor(`window.__woke.some(u => /sess-asleep\\/wake$/.test(u))`, 'Wake asks the server to wake that agent', 8000);
                // the Operator's answered ask and sent comment, from the server's list (#19916, the shape of coral://artifacts/cee5893a)
                await ev(`(async () => { const S = window.__coralStatic || '/static/', m = await import(S + 'state.js'), ago = min => new Date(Date.now() - min * 60000).toISOString(); m.state.liveSessions = [...m.state.liveSessions, { session_id: 'sess-devops', name: 'DevOps Engineer', display_name: 'DevOps Engineer', agent_type: 'claude', working: false, board_project: '${team}' }, { session_id: 'sess-copy', name: 'Copywriter', display_name: 'Copywriter', agent_type: 'claude', archived: true, sleeping: true, board_project: '${team}' }];
                    window.__waiting = [{ kind: 'answered_ask', id: 11, board: '${team}', agent: { name: 'DevOps Engineer', role: 'DevOps', session_id: 'sess-devops' }, since: ago(18), title: 'Tag v2.1.1 from 64e10a3604 once CDP is green?', operator_words: 'Approved — tag v2.1.1 and post the release notes.', goal: { id: 250, title: 'Release process' }, task: { id: 19790, title: 'Tag' }, artifact: null, thread_id: null },
                        { kind: 'comment_sent', id: 12, board: '${team}', agent: { name: 'Copywriter', role: 'Copy', session_id: 'sess-copy' }, since: ago(1440), title: null, operator_words: 'Trim the hero subhead to one sentence.', goal: { id: 241, title: 'Inbox' }, task: null, artifact: { hex: 'a'.repeat(64), name: 'landing-copy-v2.md', version: 2 }, thread_id: null }];
                    const W = await import(S + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                await waitFor(`/Answered ask/.test(document.getElementById('group-table-view').innerText) && /Comment sent/.test(document.getElementById('group-table-view').innerText)`, 'the answered ask and the sent comment are rows of the tab', 8000);
                const text = await ev(`document.getElementById('group-table-view').innerText.replace(/\\s+/g, ' ')`);
                assert.ok(text.includes('Answered ask · waiting on DevOps Engineer') && text.includes('Your answer: “Approved — tag v2.1.1 and post the release notes.”'), 'the answered ask says who it waits on and the Operator’s words: ' + text.slice(0, 900));
                assert.ok(text.includes('Comment sent · waiting on Copywriter') && text.includes('You commented: “Trim the hero subhead to one sentence.”') && /Copywriter is archived/.test(text), 'the sent comment and its archived agent: ' + text.slice(0, 900));
                assert.ok(/landing-copy-v2\.md/.test(text), 'a comment on a file is titled with the file');
                assert.match(await ev(`document.querySelector('[data-needs-tab="agent"]').textContent`), /5/, 'the tab counts the five items');
                const btn = name => ev(`[...(${row(name)}).querySelectorAll('.inbox-review-actions button, .inbox-review-actions a')].map(b => b.textContent.trim())`);
                const askBtns = await btn('Tag v2.1.1'), commentBtns = await btn('landing-copy-v2.md');
                assert.ok(askBtns.includes('Open agent') && !askBtns.includes('Wake') && !askBtns.includes('Start agent'), 'an awake agent’s ask: Open agent, no Wake: ' + JSON.stringify(askBtns));
                assert.ok(commentBtns.includes('Start agent') && commentBtns.includes('Open file'), 'an archived agent’s comment: Start agent and Open file: ' + JSON.stringify(commentBtns));
                assert.equal(await badge(), badgeBefore, 'the badge does not count them');
                const pills2 = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`);
                assert.deepEqual(pills2, ['All 5', 'Sent back 3', 'Answered ask 1', 'Comment sent 1'], 'the pills of this tab: ' + JSON.stringify(pills2));
                await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].find(b => /^Answered ask/.test(b.textContent)).click(); true`);
                await waitFor(`!!(${row('Tag v2.1.1')}) && !(${row('landing-copy-v2.md')}) && !(${row('Awake file.txt')})`, 'the Answered ask pill shows only that kind', 8000);
                await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].find(b => /^All/.test(b.textContent)).click(); true`);
                await waitFor(`!!(${row('Awake file.txt')}) && !!(${row('landing-copy-v2.md')})`, 'All shows the five again', 8000);
                await shot('agent-five');
                // a computer that cannot answer: the sent-back files stay, and the list says some could not be read
                await ev(`(async () => { window.__waitingFail = true; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                await waitFor(`/Some waiting items could not be read/.test(document.getElementById('group-table-view').innerText) && !(${row('Tag v2.1.1')}) && !!(${row('Awake file.txt')})`, 'an unreadable list is said, and the files still show', 8000);
                await ev(`(async () => { window.__waitingFail = false; window.__waiting = []; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                // nothing waiting on an agent: the empty state
                await ev(`window.__reviewItems = window.__reviewItems.filter(a => !a.tags.includes('changes requested')); import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
                await waitFor(`/Nothing waiting on an agent/.test(document.getElementById('group-table-view').innerText)`, 'the empty state of the second tab', 8000);
                assert.match(await ev(`document.getElementById('group-table-view').innerText`), /Open Activity/, 'with its way on: Open Activity');
                await shot('agent-empty');
                await ev(`document.querySelector('[data-needs-tab="you"]').click(); localStorage.removeItem('coral-inbox-agent-state'); localStorage.removeItem('coral-inbox-agent-group'); true`);
                console.log('PASS two tabs ' + width);
            } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
