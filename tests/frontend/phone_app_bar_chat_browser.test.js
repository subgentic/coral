// The phone's app bar names the view that is open (#9785, UI/UX's look check #9773 item 4): a chat opened from the Inbox's Chats folder is the Inbox's, so the bar says Inbox, not Automations.
// 390 px with touch, an isolated dev server; the history list and one chat are served by a fetch wrapper.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            const rows = [{ session_id: 'aaaaaa1', title: 'The newest chat', source_type: 'claude', display_name: 'Ada', last_timestamp: new Date().toISOString(), branch: 'main' }];
            const chat = sid => json({ session_id: sid, agent_type: 'claude', messages: [{ type: 'user', content: 'Hello' }, { type: 'assistant', text: 'Hi' }], total: 2, start: 0 });
            window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname;
                if (p === '/api/sessions/history') return json({ sessions: rows, total: rows.length, page: 1, page_size: 50 });
                if (p === '/api/sessions/history/aaaaaa1') return chat('aaaaaa1');
                if (p.startsWith('/api/sessions/history/aaaaaa1/')) return json([]);
                return real(u, o); };
            return true; })()`);
        const label = () => ev(`document.getElementById('top-menu-label').textContent`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the Inbox folders', 10000);
        assert.equal(await label(), 'Inbox', 'the Inbox names itself');
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await ev(`window.selectHistorySession('aaaaaa1'); true`);
        await waitFor(`document.getElementById('btn-resume-session') && document.getElementById('btn-resume-session').getClientRects().length > 0`, 'the chat page', 8000);
        assert.equal(await label(), 'Inbox', 'a chat opened from the Inbox is the Inbox\'s: the bar names it');
        console.log('PASS the app bar names the Inbox while a chat is open');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
