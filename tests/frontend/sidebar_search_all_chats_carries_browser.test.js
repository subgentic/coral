// The sidebar's "Search all chats for <words>" carries the words (#10263, the Desktop tester: it opened Inbox > All chats with an empty search box and an unfiltered list): the Inbox's All chats opens with the words in its search box and the
// list read with them (the history read carries q). 1280 and 390 px, isolated dev server, the harness's stand-in agents; the chat history read is answered by the test and its questions recorded.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { window.__asked = []; const R = window.fetch.bind(window); const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                const all = Array.from({ length: 6 }, (_, i) => ({ session_id: 'chat-' + i, type: 'agent', title: i === 2 ? 'The build failed' : 'Other chat ' + i, summary: i === 2 ? 'the build failed twice' : 'nothing', agent_name: 'Backend Dev', display_name: 'Backend Dev', last_timestamp: new Date(Date.now() - i * 3600000).toISOString(), duration_sec: 60, source_type: 'claude', starred: false, archived: false, active: false, tags: [] }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                    if (url.pathname === '/api/sessions/history/counts') return json({ all: 6, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: { claude: 6 }, tags: [] });
                    if (url.pathname === '/api/sessions/history') { window.__asked.push(Object.fromEntries(url.searchParams)); const q = (url.searchParams.get('q') || '').toLowerCase(); const list = q ? all.filter(s => (s.title + ' ' + s.summary).toLowerCase().includes(q)) : all; const pg = Number(url.searchParams.get('page') || 1), n = Number(url.searchParams.get('page_size') || 50); return json({ sessions: list.slice((pg - 1) * n, pg * n), total: list.length, page: pg, page_size: n }); }
                    return R(u, o); }; return true; })()`);
            await ev(`(() => { const i = document.getElementById('agent-search-input'); i.focus(); i.value = 'build failed'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(200);
            await ev(`document.getElementById('agent-search-all-chats').click(); true`);
            await waitFor(`!!window.__asked.some(a => /build failed/i.test(a.q || ''))`, `${w}: the chats read carries the words`, { timeout: 10000 });
            await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 1`, `${w}: the list`, { timeout: 8000 });
            await settle(300);
            const r = await ev(`(() => { const box = [...document.querySelectorAll('#inbox-search, #group-table-view input[type=search], #group-table-view .list-bar-search input')].filter(e => e.getClientRects().length).map(e => e.value);
                return { box, rows: [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => r.innerText.replace(/\\s+/g, ' ').slice(0, 60)), group: document.getElementById('group-table-view').dataset.group }; })()`);
            assert.equal(r.group, 'hub-inbox:chats', `${w}: the Inbox's All chats is open: ${JSON.stringify(r)}`);
            assert.ok(r.box.some(v => v === 'build failed'), `${w}: the words are in the search box: ${JSON.stringify(r)}`);
            assert.equal(r.rows.length, 1, `${w}: the list is the search's, not everything: ${JSON.stringify(r)}`);
            console.log(`ok ${w}`);
        }
        console.log('PASS the sidebar search carries its words into the Inbox All chats search and runs it');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
