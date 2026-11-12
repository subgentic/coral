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
                if (u.pathname === '/api/board/tm/messages' && opts.method === 'POST') { const b = JSON.parse(opts.body); window.__posts.push(b); return json({ id: 11 }); }
                return original(url, opts); };
            localStorage.removeItem('coral-inbox-activity-filters');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 5`, 'the page opens on Everything: all five actions');
        const pills = await ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean)`);
        for (const w of ['Everything', 'Decisions', 'Answers', 'Permissions', 'Files and tasks', 'Words sent']) assert.ok(pills.some(p => p.startsWith(w)), `a '${w}' chip: ${JSON.stringify(pills)}`);
        const pick = word => ev(`(() => { const b = [...document.querySelectorAll('.team-tb-pills .goals-chip')].find(x => x.textContent.trim().startsWith('${word}')); if (!b) return false; b.click(); return true; })()`);
        for (const [word, n] of [['Words sent', 1], ['Permissions', 1], ['Answers', 1], ['Decisions', 4], ['Everything', 5]]) {
            assert.ok(await pick(word), `the ${word} chip is there`); await ev(framesJs(4));
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === ${n}`, `${word}: ${n} row(s)`);
        }
        // the answered question opens as a thread
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].find(r => /Ship it/.test(r.textContent)).querySelector('button.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('dialog.activity-thread-dialog[open] .activity-thread-msg')`, 'the thread dialog opens', 8000);
        await waitFor(`document.querySelectorAll('.activity-thread-msg').length === 3`, 'three messages: the question, the answer, the later reply (not the unrelated one)');
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-msg .activity-thread-name')].map(e => e.textContent)`), ['Ada', 'You', 'Ada'], 'in order, the Operator as You');
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-body')].map(e => e.textContent.trim())`), ['Should we ship it?', '@Ada yes, ship it', 'Shipped. Anything else?']);
        assert.equal(await ev(`document.querySelector('.activity-thread-send').disabled`), true, 'Send reply waits for words');
        await shot('activity-thread-1280');
        await ev(`(() => { const t = document.querySelector('.activity-thread-box'); t.value = 'Yes, and tag it v2.'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.activity-thread-send').click(); return true; })()`);
        await waitFor(`window.__posts.length === 1 && document.querySelectorAll('.activity-thread-msg').length === 4`, 'the reply is sent and joins the thread', 8000);
        assert.deepEqual(await ev(`window.__posts`), [{ subscriber_id: 'Operator', as: 'Operator', content: '@Ada Yes, and tag it v2.', reply_to: 9 }], 'sent into the same thread, to the last message');
        assert.equal(await ev(`document.querySelector('.activity-thread-box').value`), '', 'the box is empty again');
        await ev(`document.querySelector('.activity-thread-actions .btn:last-child').click(); true`);
        await waitFor(`!document.querySelector('dialog.activity-thread-dialog')`, 'Close shuts it');
        // a thread the board no longer has: the record's words stand in
        await ev(`window.__noThread = true; [...document.querySelectorAll('#group-table-view tbody tr')].find(r => /Ship it/.test(r.textContent)).querySelector('button.dt-primary').click(); true`);
        await waitFor(`document.querySelectorAll('.activity-thread-msg').length === 2 && /no longer/.test(document.querySelector('.activity-thread-status').textContent)`, 'the record kept the question and the answer', 8000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-body')].map(e => e.textContent.trim())`), ['Ship it?', 'yes, ship it']);
        for (const theme of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`); await shot('activity-thread-fallback-' + theme); }
        console.log('PASS activity thread dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
