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
                        if (u.pathname === '/api/settings' && opts.method === 'PUT') return json({ ok: true }); // the page's own settings saves (Getting started's done list) never reach the server, so no run leaves a setting changed
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
                const shot = async (name) => { if (!process.env.CORAL_SCREENSHOT_DIR) return; for (const theme of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`); await new Promise(r => setTimeout(r, 250)); require('fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('fs').writeFileSync(require('path').join(process.env.CORAL_SCREENSHOT_DIR, `two-tabs-${name}-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }; // sleep-ok: the menu opening, the repaint after a theme change, before a picture
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
                const menuOf = name => ev(`(async () => { const t = (${row(name)}).querySelector('[aria-label^="More actions for"]'); t.click(); await new Promise(x => setTimeout(x, 250)); const m = [...document.querySelectorAll('.inbox-row-more .menu:not([hidden]) [role=menuitem]')].map(b => b.textContent.trim()); t.click(); await new Promise(x => setTimeout(x, 150)); return m; })()`); // sleep-ok: the menu opening, the repaint after a theme change, before a picture
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
                const gh = await ev(`[...document.querySelectorAll('.inbox-needs-results .dt-group')].map(g => ({ t: g.textContent.replace(/\\s+/g, ' ').trim(), meta: g.querySelector('.inbox-group-meta')?.textContent || '', btn: [...g.querySelectorAll('button')].map(b => b.textContent.trim()) }))`);
                const ghOf = n => gh.find(g => g.t.includes(n));
                assert.match(ghOf('Writer B').meta, /^1 waiting · since .+ ago$/, 'the heading says how many wait and since when: ' + JSON.stringify(gh));
                assert.deepEqual(ghOf('Writer B').btn, ['Wake Writer B'], 'an asleep agent’s heading has Wake: ' + JSON.stringify(gh));
                assert.deepEqual(ghOf('Writer C').btn, ['Start agent'], 'an archived agent’s heading has Start agent: ' + JSON.stringify(gh));
                assert.deepEqual(ghOf('Writer A').btn, [], 'an awake agent’s heading has no button: ' + JSON.stringify(gh));
                assert.equal(await ev(`document.querySelectorAll('.inbox-agent-status .inbox-st-dot').length`), 3, 'the count line has a coloured dot for each of the three states');
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
                assert.ok(text.includes('Answered ask') && text.includes('Waiting on DevOps Engineer') && text.includes('Your answer: “Approved — tag v2.1.1 and post the release notes.”'), 'the answered ask says who it waits on and the Operator’s words: ' + text.slice(0, 900));
                assert.ok(text.includes('Comment sent') && text.includes('Waiting on Copywriter') && text.includes('You commented: “Trim the hero subhead to one sentence.”') && /Copywriter is archived/.test(text), 'the sent comment and its archived agent: ' + text.slice(0, 900));
                assert.ok(/Comment on landing-copy-v2\.md/.test(text), 'a comment on a file is titled Comment on <file>, as the mock has it (#20075)');
                assert.match(await ev(`document.querySelector('[data-needs-tab="agent"]').textContent`), /5/, 'the tab counts the five items');
                const btn = name => ev(`[...(${row(name)}).querySelectorAll('.inbox-review-actions button, .inbox-review-actions a')].map(b => b.textContent.trim())`);
                const askBtns = await btn('Tag v2.1.1'), commentBtns = await btn('landing-copy-v2.md');
                assert.ok(askBtns.includes('Open agent') && !askBtns.includes('Wake') && !askBtns.includes('Start agent'), 'an awake agent’s ask: Open agent, no Wake: ' + JSON.stringify(askBtns));
                assert.ok(!askBtns.includes('Open goal') && !askBtns.includes('Open task'), 'an answered ask has no Open goal button: the goal and the task are chips (#20075): ' + JSON.stringify(askBtns));
                if (width === 1280) assert.ok(/No reply or task update yet/.test(await ev(`(${row('Tag v2.1.1')}).textContent`)), 'an answered ask says No reply or task update yet (#20075)');
                                if (width === 1280) assert.equal(await ev(`getComputedStyle((${row('Tag v2.1.1')}).querySelector('.inbox-nudge')).borderTopColor`), 'rgba(0, 0, 0, 0)', 'Nudge is quiet text, not a bordered button (#20075)');
                assert.ok(askBtns.includes('Nudge'), 'an awake agent’s ask has a Nudge button beside Open agent, as the mock draws it (#20067 row 15): ' + JSON.stringify(askBtns));
                assert.ok(!commentBtns.includes('Nudge'), 'an archived agent is not nudged: ' + JSON.stringify(commentBtns));
                assert.equal(await ev(`!!(${row('Tag v2.1.1')}).querySelector('.dt-check input')`), true, 'an answered ask has a checkbox like every Waiting on an agent row (#20067 row 13)');
                assert.equal(await ev(`!!(${row('landing-copy-v2.md')}).querySelector('.dt-check input')`), true, 'a sent comment has a checkbox too');
                assert.equal(await ev(`(${row('Tag v2.1.1')}).querySelector('.inbox-kind-icon').getAttribute('aria-label')`), 'Answered ask', 'the row’s icon is named for what the row is, not as a Question (#20067 row 14)');
                assert.equal(await ev(`(() => { const a = (${row('landing-copy-v2.md')}).querySelector('.inbox-review-actions'), edge = a.getBoundingClientRect().right + 1; return [...a.children].filter(c => getComputedStyle(c).position !== 'absolute').every(c => c.getBoundingClientRect().right <= edge && c.scrollWidth <= c.clientWidth + 1); })()`), true, width + ': every action stays inside the card, Open agent is not cut (#20075)');
                await shot('answered');
                assert.ok(commentBtns.includes('Start agent') && commentBtns.includes('Open thread'), 'an archived agent’s comment: Start agent and Open thread: ' + JSON.stringify(commentBtns));
                // an answer or a comment wakes a sleeping agent that is not archived (#19897, #19901): the line says so and there is no Wake
                await ev(`(async () => { const S = window.__coralStatic || '/static/', m = await import(S + 'state.js'); m.state.liveSessions = m.state.liveSessions.map(s => s.session_id === 'sess-devops' ? { ...s, sleeping: true } : s); const W = await import(S + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); document.dispatchEvent(new CustomEvent('coral:needs-updated')); document.querySelector('[data-needs-tab="you"]').click(); await new Promise(r => setTimeout(r, 200)); /* sleep-ok: the other tab draws first, then this one again */ document.querySelector('[data-needs-tab="agent"]').click(); return true; })()`);
                await waitFor(`/DevOps Engineer is asleep/.test(document.getElementById('group-table-view').innerText)`, 'a sleeping agent with an answered ask is said to be waking', 8000);
                assert.match(await ev(`document.getElementById('group-table-view').innerText.replace(/\\s+/g, ' ')`), /DevOps Engineer is asleep . your answer is waking it/, 'the line says the answer is waking it');
                assert.ok(!(await btn('Tag v2.1.1')).includes('Wake'), 'no Wake where the answer wakes the agent: ' + JSON.stringify(await btn('Tag v2.1.1')));
                assert.equal(await badge(), badgeBefore, 'the badge does not count them');
                const pills2 = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`);
                assert.deepEqual(pills2, ['All 5', 'Sent back 3', 'Answered ask 1', 'Comment sent 1'], 'the pills of this tab: ' + JSON.stringify(pills2));
                await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].find(b => /^Answered ask/.test(b.textContent)).click(); true`);
                await waitFor(`!!(${row('Tag v2.1.1')}) && !(${row('landing-copy-v2.md')}) && !(${row('Awake file.txt')})`, 'the Answered ask pill shows only that kind', 8000);
                await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills .goals-chip')].find(b => /^All/.test(b.textContent)).click(); true`);
                await waitFor(`!!(${row('Awake file.txt')}) && !!(${row('landing-copy-v2.md')})`, 'All shows the five again', 8000);
                if (width === 390) { const clash = await ev(`[...document.querySelectorAll('#group-table-view tr.inbox-kind-row')].map(tr => { const c = tr.querySelector('.inbox-wait-state'), m = tr.querySelector('.inbox-row-more-toggle, .dt-mail-more-toggle'); if (!c || !m || !c.getClientRects().length || !m.getClientRects().length) return null; const a = c.getBoundingClientRect(), b = m.getBoundingClientRect(); return a.right > b.left + 1 && a.left < b.right - 1 && a.bottom > b.top + 1 && a.top < b.bottom - 1; }).filter(x => x === true).length`); assert.equal(clash, 0, '390 px: no row\'s state chip lies under its more dots (#20066)'); }
                await shot('agent-five');
                if (width === 390) assert.match(await ev(`document.querySelector('.inbox-agent-status').innerText.trim()`), /^5 waiting · 3 inactive$/, 'a phone shows the mock’s one short count line, with no stray separators');
                if (width === 1280) {
                    const tops = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].map(r => Math.round(r.getBoundingClientRect().top))`);
                    const before = await tops();
                    await ev(`(${row('Awake file.txt')}).querySelector('.dt-check input').click(); true`);
                    await waitFor(`!!document.querySelector('.team-tb-selection')`, 'the bulk bar shows for a ticked row', 8000);
                    await new Promise(r => setTimeout(r, 300)); // sleep-ok: let the bar settle
                    assert.deepEqual(await tops(), before, 'ticking a row on the agent tab moves no row');
                    await shot('agent-ticked');
                    await ev(`(${row('Awake file.txt')}).querySelector('.dt-check input').click(); true`);
                    await waitFor(`!document.querySelector('.team-tb-selection')`, 'the bar goes when nothing is ticked', 8000);
                }
                if (width === 1280) { // walk #20009 item 5: Getting started shows on Waiting on you only, and that tab counts it
                    const count = key => ev(`Number(document.querySelector('[data-needs-tab="${key}"] .inbox-needs-tab-count')?.textContent.replace(/[^0-9]/g, '') || -1)`);
                    const tab = async key => { await ev(`document.querySelector('[data-needs-tab="${key}"]').click(); true`); await new Promise(r => setTimeout(r, 400)); }; // sleep-ok: let the tab redraw
                    const welcome = () => ev(`document.querySelectorAll('#group-table-view .inbox-welcome-actions').length`);
                    await tab('you'); const youBefore = await count('you');
                    await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.settings = { ...state.settings, inbox_welcome: 'on' }; document.dispatchEvent(new CustomEvent('coral:welcome-changed')); return true; })()`);
                    await tab('agent'); await tab('you');
                    const shown = await welcome();
                    assert.ok(shown >= 1, 'Getting started rows show on Waiting on you');
                    assert.equal(await count('you'), youBefore + shown, 'Waiting on you counts the Getting started rows it shows');
                    const nums = () => ev(`({ tab: Number(document.querySelector('[data-needs-tab="you"] .inbox-needs-tab-count')?.textContent.replace(/[^0-9]/g, '')), sidebar: Number(document.querySelector('#inbox-nav-list .view-list-item[data-key="needs"] .view-list-count')?.textContent.replace(/[^0-9]/g, '')), badge: Number(document.getElementById('nav-tab-hub-inbox-badge')?.textContent.replace(/[^0-9]/g, '')) })`);
                    for (let i = 0; i < 20; i++) { const n = await nums(); if (n.tab === n.sidebar && n.sidebar === n.badge) break; await new Promise(r => setTimeout(r, 250)); } // sleep-ok: the counts settle after a redraw
                    const n = await nums();
                    assert.ok(n.tab >= shown && n.tab === n.sidebar && n.sidebar === n.badge, 'Waiting on you, the sidebar and the red Inbox badge show one number, Getting started rows included (#20017): ' + JSON.stringify(n));
                    const allChip = await ev(`Number(document.querySelector('button.goals-chip[data-filter=all]')?.textContent.replace(/[^0-9]/g, '') || -1)`);
                    assert.equal(allChip, n.tab, 'the All chip counts what the tab and the list line count, Getting started rows included (#20067 row 4): chip ' + allChip + ', tab ' + n.tab);
                    await tab('agent');
                    assert.equal(await welcome(), 0, 'Getting started rows do not show on Waiting on an agent');
                    await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.settings = { ...state.settings, inbox_welcome: 'off' }; return true; })()`);
                    await tab('you');
                }
                if (width === 1280) { // walk #20009 item 6: a file that was sent back stays one 'Sent back' row when a comment on it is also waiting
                    await ev(`(async () => { window.__waiting = [...window.__waiting, { kind: 'comment_sent', id: 'cmt-99', board: '${team}', agent: { name: 'Writer A', role: 'Writer', session_id: 'sess-awake' }, since: new Date(Date.now() - 60000).toISOString(), title: 'A file', operator_words: 'Trim it', goal: null, task: null, artifact: { hex: (2).toString(16).padStart(64, '0'), name: 'Awake file.txt', version: 1 }, thread_id: null }]; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                    await ev(`document.querySelector('[data-needs-tab="you"]').click(); true`); await ev(`document.querySelector('[data-needs-tab="agent"]').click(); true`);
                    await new Promise(r => setTimeout(r, 500)); // sleep-ok: let the list redraw
                    assert.equal(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].filter(r => r.textContent.includes('Awake file.txt')).length`), 1, 'the sent-back file is one row');
                    assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .inbox-sent-back')].filter(c => /^Comment sent$/.test(c.textContent) && c.closest('tr').textContent.includes('Awake file.txt')).length`), 0, 'it does not flip to Comment sent');
                    await ev(`(async () => { window.__waiting = window.__waiting.filter(i => i.id !== 'cmt-99'); const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                }
                if (width === 1280) { // QA on #20075: a comment on a goal (no file) keeps Open thread, which opens the goal
                    await ev(`(async () => { window.__waiting = [...window.__waiting, { kind: 'comment_sent', id: 'cmt-goal', board: '${team}', agent: { name: 'DevOps Engineer', role: 'DevOps', session_id: 'sess-devops' }, since: new Date(Date.now() - 120000).toISOString(), title: null, operator_words: 'Add the rollback step.', goal: { id: 250, title: 'Release plan note' }, task: null, artifact: null, thread_id: null }]; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                    await waitFor(`!!(${row('Release plan note')})`, 'the goal comment is a row', 8000);
                    assert.ok((await btn('Release plan note')).includes('Open thread'), 'a sent comment on a goal has Open thread too (QA #20075): ' + JSON.stringify(await btn('Release plan note')));
                    await ev(`(async () => { window.__waiting = window.__waiting.filter(i => i.id !== 'cmt-goal'); const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                }
                // a computer that cannot answer: the sent-back files stay, and the list says some could not be read
                await ev(`(async () => { window.__waitingFail = true; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                await waitFor(`/Some waiting items could not be read/.test(document.getElementById('group-table-view').innerText) && !(${row('Tag v2.1.1')}) && !!(${row('Awake file.txt')})`, 'an unreadable list is said, and the files still show', 8000);
                await ev(`(async () => { window.__waitingFail = false; window.__waiting = []; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                // the REAL route's own output (captured from the #19916/#19923 handler's test on 945c27a3ad): string ids, an ISO since, a cut Operator comment ending in an ellipsis, null goal/task/artifact
                const real = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'waiting_on_agent_real.json'), 'utf8'));
                await ev(`(async () => { window.__waiting = ${JSON.stringify(real.items)}; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                await waitFor(`!!(${row('pick one')}) && !!(${row('A file')})`, 'the real route\'s two rows draw', 8000);
                const realText = await ev(`document.getElementById('group-table-view').innerText`);
                assert.match(realText, /Answered ask/, 'real: the answered-ask chip'); assert.match(realText, /Comment sent/, 'real: the comment-sent chip');
                assert.match(realText, /the first/, 'real: the Operator\'s answer'); assert.match(realText, /xxxx[^\n]*\u2026/, 'real: the cut comment keeps its ellipsis');
                assert.equal(await ev(`(${row('pick one')}).classList.contains('dt-unread')`), false, 'real: a waiting row is not unread');
                await shot('agent-real-route');
                await ev(`(async () => { window.__waiting = []; const W = await import((window.__coralStatic || '/static/') + 'inbox_waiting_agent.js'); W.forget(); await W.load({ force: true }); return true; })()`);
                // nothing waiting on an agent: the empty state
                await ev(`window.__reviewItems = window.__reviewItems.filter(a => !a.tags.includes('changes requested')); import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
                await waitFor(`/Nothing waiting on an agent/.test(document.getElementById('group-table-view').innerText)`, 'the empty state of the second tab', 8000);
                assert.match(await ev(`document.getElementById('group-table-view').innerText`), /View past actions in Activity/, 'with its way on: Open Activity');
                await shot('agent-empty');
                await ev(`document.querySelector('[data-needs-tab="you"]').click(); localStorage.removeItem('coral-inbox-agent-state'); localStorage.removeItem('coral-inbox-agent-group'); true`);
                console.log('PASS two tabs ' + width);
            } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
