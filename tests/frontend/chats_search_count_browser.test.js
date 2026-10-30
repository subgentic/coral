// The All chats heading counts the chats the search shows (#10357, Beta tester: "All chats 0" over one result): with words in the search the table's count is the shown chats once the read is whole,
// not the folder's total from the counts route (here 0, as when the counts are not in yet); with no search it is that total, or the chats listed when the list is whole and has more than the total says (after a clear: #10512). The history read is stood in at GET /api/sessions/history.
// 1280 px, isolated dev server, the harness's page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            const hit = { session_id: 'chat-hit', type: 'agent', title: 'The plum chat', summary: 'PLUM-4471 was here', agent_type: 'claude', source_type: 'claude', last_timestamp: new Date().toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [] };
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 0, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: [hit], total: 1, page: 1, page_size: 50 });
                return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); };
            return true; })()`);
        const spec = q => ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => { const s = m.chatsSpec('chats', { query: ${JSON.stringify(q)}, params: {}, redraw() {}, after() {} }); return { count: s.count, rows: s.rows.length }; })`);
        await spec('PLUM-4471'); await settle(600);
        const hit = await spec('PLUM-4471');
        assert.equal(hit.rows, 1, 'the search read one chat: ' + JSON.stringify(hit));
        assert.equal(hit.count, 1, 'the heading counts the chat shown, not the folder total of 0: ' + JSON.stringify(hit));
        await spec(''); await settle(600);
        const all = await spec('');
        assert.equal(all.rows, 1, 'the unfiltered list read the one chat: ' + JSON.stringify(all));
        assert.equal(all.count, 1, 'after a clear the heading counts the chats listed at once, not the 0 the counts route still says (#10512): ' + JSON.stringify(all));
        console.log('PASS the All chats count follows the search');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
