// All chats on its first load (#10536, Desktop recheck: "header count 0 beside 3 rows, and the list empty until the search box is touched"): opened for the first time with history that has three chats, the list shows
// the three at once and the heading counts them. The history and its counts are stood in at /api/sessions/history[/counts]. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })); const R = window.fetch.bind(window);
            const chat = i => ({ session_id: 'old-' + i, type: 'agent', title: 'Old chat ' + i, summary: 'earlier work ' + i, agent_type: 'claude', source_type: 'claude', display_name: '', agent_name: 'alpha', last_timestamp: new Date(Date.now() - i * 3600000).toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [] });
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 3, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: { claude: 3 }, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: [0, 1, 2].map(chat), total: 3, page: 1, page_size: 50 });
                return R(u, o); }; return true; })()`);
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.getElementById('inbox-search')`, 'the Inbox', 10000);
        await ev(`import(${MOD} + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view') && document.getElementById('group-table-view').getClientRects().length > 0`, 'the All chats table', 10000);
        await sleep(2500); // sleep-ok: the first read and the counts land
        const got = await ev(`(() => { const v = document.getElementById('group-table-view'); const head = v.querySelector('h2, .group-table-title, .list-bar-title, [data-heading]'); return { rows: v.querySelectorAll('.dt-table tbody tr:not(.dt-group)').length, text: v.innerText.replace(/\\s+/g, ' ').slice(0, 160) }; })()`);
        assert.equal(got.rows, 3, 'the three chats are listed on the first load: ' + JSON.stringify(got));
        assert.doesNotMatch(got.text, /All chats 0\b/, 'and the heading does not say 0: ' + JSON.stringify(got));
        console.log('PASS All chats shows its three chats on the first load');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
