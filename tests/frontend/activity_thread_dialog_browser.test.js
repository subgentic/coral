// Activity opens like the Inbox (#15724, the Operator's pick of design B): kind chips over the record (the page opens on Everything, a chip narrows it, nothing is lost), and an answered question opens as a thread:
// the agent's question, the Operator's answer and the later replies in order, then a reply box that sends into the same thread. The board's messages and the record are stubbed in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => {
            const prefix = window.__coralStatic || '/static/', ago = m => new Date(Date.now() - m * 60000).toISOString(), json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
            const row = (id, action, item_kind, item_id, title, note, extra = {}) => ({ id, at: ago(id), team: 'tm', action, item_kind, item_id: String(item_id), title, note, source: 'dashboard', ...extra });
            window.__activityRows = [row(5, 'answer', 'question', 7, 'Ship it?', 'Your answer: yes, ship it', { asker: 'Ada' }), row(4, 'task_complete', 'task', 12, 'Ship release', ''), row(3, 'prompt_allow', 'agent', 'claude-ada', 'claude-ada', 'Yes, once'), row(2, 'chat_send', 'chat', 'board:tm', 'tm', 'hello'), row(1, 'approve', 'file', 'a'.repeat(64), 'plan.md', '')];
            const msg = (id, who, content, reply_to) => ({ id, project: 'tm', subscriber_id: who, content, created_at: ago(30 - id), ...(reply_to ? { reply_to } : {}) });
            window.__messages = [msg(7, 'Ada', 'Should we ship it?'), msg(8, 'Operator', '@Ada yes, ship it', 7), msg(9, 'Ada', 'Shipped. Anything else?', 8), msg(10, 'Bob', 'Unrelated chatter')];
            window.__posts = []; window.__noThread = false;
            const original = window.fetch;
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname === '/api/activity') return json({ actions: window.__activityRows, check: { intact: true, rows: window.__activityRows.length } });
                if (u.pathname === '/api/board/tm/messages/all') return json({ messages: window.__noThread ? [] : window.__messages, total: 4, limit: 200, offset: 0 });
                if (u.pathname.startsWith('/api/board/tm/asks/') && u.pathname.endsWith('/close') && opts.method === 'POST') { (window.__closes = window.__closes || []).push(JSON.parse(opts.body)); return json({ ok: true, reopened: true }); }
                if (u.pathname === '/api/upload') { window.__uploads = (window.__uploads || 0) + 1; window.__uploadFor = (window.__uploadFor || []); window.__uploadFor.push(opts.body && opts.body.get ? opts.body.get('session_id') : ''); return json({ path: '/tmp/up/pic.png', filename: 'pic.png' }); }
                if (u.pathname === '/api/board/tm/messages' && opts.method === 'POST') { const b = JSON.parse(opts.body); window.__posts.push(b); return json({ id: 11 }); }
                return original(url, opts); };
            localStorage.removeItem('coral-inbox-activity-filters');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length === 5`, 'the page opens on Everything: all five actions');
        const pills = await ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean)`);
        for (const w of ['Everything', 'Decisions', 'Answers', 'Permissions', 'Files and tasks', 'Words sent']) assert.ok(pills.some(p => p.startsWith(w)), `a '${w}' chip: ${JSON.stringify(pills)}`);
        const pick = word => ev(`(() => { const b = [...document.querySelectorAll('.team-tb-pills .goals-chip')].find(x => x.textContent.trim().startsWith('${word}')); if (!b) return false; b.click(); return true; })()`);
        for (const [word, n] of [['Words sent', 1], ['Permissions', 1], ['Answers', 1], ['Decisions', 4], ['Everything', 5]]) {
            assert.ok(await pick(word), `the ${word} chip is there`); await ev(framesJs(4));
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length === ${n}`, `${word}: ${n} row(s)`);
        }
        // the answered question opens as a thread
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(r => /Ship it/.test(r.textContent)).querySelector('button.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('dialog.activity-thread-dialog[open] .activity-thread-msg')`, 'the thread dialog opens', 8000);
        await waitFor(`document.querySelectorAll('.activity-thread-msg').length === 3`, 'three messages: the question, the answer, the later reply (not the unrelated one)');
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-msg .activity-thread-name')].map(e => e.textContent)`), ['Ada', 'You', 'Ada'], 'in order, the Operator as You');
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-body')].map(e => e.textContent.trim())`), ['Should we ship it?', '@Ada yes, ship it', 'Shipped. Anything else?']);
        assert.equal(await ev(`document.querySelector('.activity-thread-send').disabled`), true, 'Send reply waits for words');
        // mockup v3 (#15774): one Reply box with Attach image and its hint, the buttons at the right with Send reply last, the thread as a chat (the Operator's words on the right)
        const v3 = await ev(`(() => { const d = document.querySelector('dialog.activity-thread-dialog'); const b = [...d.querySelectorAll('.activity-thread-actions .btn')].filter(x => !x.hidden).map(x => x.textContent.trim()); const mine = d.querySelector('.activity-thread-mine'), other = d.querySelector('.activity-thread-msg:not(.activity-thread-mine)'); return { attach: [...d.querySelectorAll('button')].some(x => x.textContent.trim() === 'Attach image'), hint: /Paste or drop an image here too/.test(d.textContent), buttons: b, reply: !!d.querySelector('textarea') && d.querySelectorAll('textarea').length === 1, mineRight: !!mine && !!other && mine.getBoundingClientRect().left > other.getBoundingClientRect().left }; })()`);
        assert.ok(v3.attach && v3.hint && v3.reply && v3.mineRight, JSON.stringify(v3));
        assert.equal(v3.buttons[v3.buttons.length - 1], 'Send reply', 'Send reply is the last, right-most button: ' + JSON.stringify(v3.buttons));
        await shot('activity-thread-1280');
        // images in the reply (#15774): with the asking agent running the picture goes up and its path leads the reply; with it not running, a toast says so and nothing is uploaded or sent
        const pickImage = () => ev(`(async () => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; c.getContext('2d').fillRect(0, 0, 8, 8); const blob = await new Promise(r => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'pic.png', { type: 'image/png' })); const i = document.querySelector('dialog.activity-thread-dialog input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await ev(`window.__uploads = 0; true`);
        await pickImage();
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: a refusal draws nothing to wait for
        assert.equal(await ev(`window.__uploads`), 0, 'no agent running: nothing is uploaded');
        assert.equal(await ev(`document.querySelectorAll('dialog.activity-thread-dialog .image-attachment').length`), 0, 'and no picture is attached');
        assert.equal(await ev(`window.__posts.length`), 0, 'and nothing is sent');
        // another team's agent with the same name is not the one asked (#15801): no upload goes to it
        await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.liveSessions = [...(m.state.liveSessions || []), { name: 'Ada', display_name: 'Ada', session_id: 'sid-other-team', agent_type: 'claude', type: 'live', board_project: 'other' }]; return true; })`);
        await pickImage();
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: a refusal draws nothing to wait for
        assert.equal(await ev(`window.__uploads`), 0, 'only another team has an Ada: nothing is uploaded');
        assert.equal(await ev(`document.querySelectorAll('dialog.activity-thread-dialog .image-attachment').length`), 0);
        await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.liveSessions = [...(m.state.liveSessions || []), { name: 'Ada', display_name: 'Ada', session_id: 'sid-ada', agent_type: 'claude', type: 'live', board_project: 'tm' }]; return true; })`);
        await pickImage();
        await waitFor(`document.querySelectorAll('dialog.activity-thread-dialog .image-attachment').length === 1`, 'the agent is running: the picture is attached', 8000);
        assert.equal(await ev(`window.__uploads`), 1, 'it was uploaded once');
        assert.deepEqual(await ev(`window.__uploadFor`), ['sid-ada'], "and for this team's agent");
        await ev(`document.querySelector('.activity-thread-send').click(); true`);
        await waitFor(`window.__posts.length === 1`, 'the reply with the picture is sent', 8000);
        assert.match(await ev(`window.__posts[0].content`), /^@Ada .*\/tmp\/up\/pic\.png/s, 'the picture\'s path leads the reply, to the agent');
        await ev(`window.__posts.length = 0; true`);
        await ev(`(() => { const t = document.querySelector('.activity-thread-box'); t.value = 'Yes, and tag it v2.'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.activity-thread-send').click(); return true; })()`);
        await waitFor(`window.__posts.length === 1 && document.querySelectorAll('.activity-thread-msg').length === 5`, 'the reply is sent and joins the thread', 8000);
        assert.deepEqual(await ev(`window.__posts`), [{ subscriber_id: 'Operator', as: 'Operator', content: '@Ada Yes, and tag it v2.', reply_to: 11 }], 'sent into the same thread, to the last message (the picture reply before it)');
        assert.equal(await ev(`document.querySelector('.activity-thread-box').value`), '', 'the box is empty again');
        await ev(`[...document.querySelectorAll('.activity-thread-actions .btn')].find(b => b.textContent.trim() === 'Close').click(); true`);
        await waitFor(`!document.querySelector('dialog.activity-thread-dialog')`, 'Close shuts it');
        // a thread the board no longer has: the record's words stand in
        await ev(`window.__noThread = true; [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(r => /Ship it/.test(r.textContent)).querySelector('button.dt-primary').click(); true`);
        await waitFor(`document.querySelectorAll('.activity-thread-msg').length === 2 && /no longer/.test(document.querySelector('.activity-thread-status').textContent)`, 'the record kept the question and the answer', 8000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-body')].map(e => e.textContent.trim())`), ['Ship it?', 'yes, ship it']);
        for (const theme of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`); await shot('activity-thread-fallback-' + theme); }
        // Reopen question (#15792): the answered question goes back to Needs you, unanswered, and the dialog closes
        await ev(`[...document.querySelectorAll('.activity-thread-actions .btn')].find(b => b.textContent.trim() === 'Close').click(); true`);
        await waitFor(`!document.querySelector('dialog.activity-thread-dialog')`, 'the fallback dialog shuts');
        await ev(`window.__noThread = false; window.__closes = []; [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(r => /Ship it/.test(r.textContent)).querySelector('button.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('dialog.activity-thread-dialog[open] .activity-thread-reopen')`, 'the thread opens with Reopen question', 8000);
        await ev(`document.querySelector('.activity-thread-reopen').click(); true`);
        await waitFor(`(window.__closes || []).length === 1 && !document.querySelector('dialog.activity-thread-dialog')`, 'Reopen question posts the undo with unanswer and shuts the dialog', 8000);
        assert.deepEqual(await ev(`window.__closes[0]`), { undo: true, unanswer: true });
        console.log('PASS activity thread dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
