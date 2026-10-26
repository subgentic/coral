// The Chats page follows the sidebar's search (#7722, the #7720 audit's finding 5): with a search typed the sidebar lists the chats that have hits, and the page's table lists the same chats, its count
// the same number; with the search cleared the table is the whole list again, and a search that finds nothing says so in the page. 1280 px, isolated dev server; the history list and the search answer are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SESSIONS = [
    { session_id: 'aaaaaaaa-0001', summary_title: 'Release notes chat', display_name: 'Orchestrator', agent_name: 'Orchestrator', agent_type: 'claude', last_timestamp: '2026-10-01T10:00:00Z', duration_sec: 600 },
    { session_id: 'aaaaaaaa-0002', summary_title: 'Build fix chat', display_name: 'Backend Dev', agent_name: 'Backend Dev', agent_type: 'claude', last_timestamp: '2026-10-02T10:00:00Z', duration_sec: 300 },
    { session_id: 'aaaaaaaa-0003', summary_title: 'Planning chat', display_name: 'Lead', agent_name: 'Lead', agent_type: 'codex', last_timestamp: '2026-10-03T10:00:00Z', duration_sec: 120 },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch.bind(window); window.__hits = ['aaaaaaaa-0001', 'aaaaaaaa-0002'];
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/sessions/history/search') return Promise.resolve(new Response(JSON.stringify({ status: 'complete', results: window.__hits.map(id => ({ session_id: id, type: 'chat', source: 'claude', hits: [{ role: 'user', excerpt: 'release', timestamp: '2026-10-01T10:00:00Z', locator: { session_id: id }, matches: [] }] })) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('history'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'history_list.js').then(m => { m.renderHistorySessions(${JSON.stringify(SESSIONS)}, 3, 1, 50); return true; })`);
        const table = () => ev(`(() => { const v = document.getElementById('group-table-view'); if (!v || v.offsetParent === null) return null; return { title: (v.querySelector('#group-table-title') || {}).textContent, count: (v.querySelector('.group-table-head .session-group-count') || {}).textContent, rows: [...v.querySelectorAll('tbody tr')].map(r => r.querySelector('.group-table-link').textContent.trim()), text: v.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) }; })()`);
        await waitFor(`!!document.querySelector('#group-table-view tbody tr')`, 'the Chats page table', 10000);
        let t = await table();
        assert.deepEqual([t.count, t.rows.length], ['3', 3], 'no search: the page lists all 3 chats ' + JSON.stringify(t));

        // a search with hits in two chats
        await ev(`import((window.__coralStatic||'/static/')+'chat_search.js').then(m => m.searchChats('release')).then(() => true)`);
        await waitFor(`!!document.querySelector('#chat-search-results .chat-search-result')`, 'the search results in the sidebar', 10000);
        const side = await ev(`[...document.querySelectorAll('#chat-search-results .chat-search-result-header strong')].map(e => e.textContent.trim())`);
        assert.equal(side.length, 2, 'the sidebar lists 2 chats with hits ' + JSON.stringify(side));
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the page to follow the search', 5000).catch(() => {});
        t = await table();
        assert.deepEqual(t.rows, ['Release notes chat', 'Build fix chat'], 'the page lists the same 2 chats as the sidebar ' + JSON.stringify(t));
        assert.equal(t.count, '2', 'and its count says 2 ' + JSON.stringify(t));

        // a search that finds nothing
        await ev(`window.__hits = []; import((window.__coralStatic||'/static/')+'chat_search.js').then(m => m.searchChats('zzz')).then(() => true)`);
        await waitFor(`/No matching chats/.test(document.getElementById('chat-search-results').textContent)`, 'the empty search', 10000);
        await waitFor(`!document.querySelector('#group-table-view tbody tr')`, 'the page to follow the empty search', 5000).catch(() => {});
        t = await table();
        assert.ok(t && t.rows.length === 0 && /No matching chats/.test(t.text), 'the page says no chat matches, not the whole list ' + JSON.stringify(t));

        // the search cleared
        await ev(`import((window.__coralStatic||'/static/')+'chat_search.js').then(m => m.searchChats('')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, 'the whole list again', 5000).catch(() => {});
        t = await table();
        assert.deepEqual([t.count, t.rows.length], ['3', 3], 'cleared: the page lists all 3 chats again ' + JSON.stringify(t));
        console.log('PASS the Chats page follows the search');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
