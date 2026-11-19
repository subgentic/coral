// An answered question's dialog lists the Operator's reply even when it sits far down a busy board (#19535): the page after the question holds 200 messages, and the reply was 330 messages later,
// so a single page missed it. The board is stubbed with the real paging (after_id, oldest first, limit): the thread has the question, the reply and the agent's answer to it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => {
            const prefix = window.__coralStatic || '/static/', ago = m => new Date(Date.now() - m * 60000).toISOString(), json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
            window.__activityRows = [{ id: 5, at: ago(5), team: 'tm', action: 'answer', item_kind: 'question', item_id: '1000', title: 'Keep the preview?', note: 'Your answer: kill it', source: 'dashboard', asker: 'Ada' }];
            const msg = (id, who, content, reply_to) => ({ id, project: 'tm', subscriber_id: who, content, created_at: ago(1000 - (id - 1000)), ...(reply_to ? { reply_to } : {}) });
            window.__messages = [msg(1000, 'Ada', 'Keep the preview?')];
            for (let i = 1001; i < 1331; i++) window.__messages.push(msg(i, 'Bob', 'chatter ' + i));
            window.__messages.push(msg(1331, 'Operator', '@Ada I am done with this, kill it', 1000), msg(1332, 'Ada', 'Killed it.', 1331));
            window.__asked = [];
            const original = window.fetch;
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname === '/api/activity') return json({ actions: window.__activityRows, check: { intact: true, rows: 1 } });
                if (u.pathname === '/api/board/tm/messages/all') { const after = Number(u.searchParams.get('after_id') || 0), limit = Number(u.searchParams.get('limit') || 200); window.__asked.push(after);
                    return json({ messages: window.__messages.filter(m => m.id > after).slice(0, limit), total: window.__messages.length, limit, offset: 0 }); }
                return original(url, opts); };
            localStorage.removeItem('coral-inbox-activity-filters');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view .ac-row').length === 1`, 'the answered question is in Activity');
        await ev(`document.querySelector('#group-table-view .ac-row button.ac-title').click(); true`);
        await waitFor(`document.querySelectorAll('.activity-thread-msg').length === 3`, 'the thread lists the question, the far reply and the agent\'s answer', 8000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-body')].map(e => e.textContent.trim())`), ['Keep the preview?', '@Ada I am done with this, kill it', 'Killed it.']);
        assert.deepEqual(await ev(`[...document.querySelectorAll('.activity-thread-name')].map(e => e.textContent)`), ['Ada', 'You', 'Ada']);
        assert.ok((await ev(`window.__asked.length`)) >= 2, 'the board was read on past the first page');
        console.log('PASS activity thread far reply');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
