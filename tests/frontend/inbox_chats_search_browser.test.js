// Inbox > All chats search (#10137, Desktop #10131): a search for a hyphenated code answers with the chats and, for each, one line of its text around the match (the desktop title cell
// and the phone row show it); a search the server refuses says "Search failed" instead of "Loading chats..." for ever, and the next search works. At 1280 and at 390. GET /api/sessions/history is
// answered by the test. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');

const ROWS = [
    { session_id: 'sess-1', source_type: 'claude', agent_name: 'Frontend Dev', display_name: 'Frontend Dev', summary: 'Working on the importer', last_timestamp: '2026-10-25T10:00:00Z', duration_sec: 600, starred: false, archived: false, active: false, tags: [] },
    { session_id: 'sess-2', source_type: 'codex', agent_name: 'Backend Dev', display_name: 'Backend Dev', summary: 'Cold start numbers', last_timestamp: '2026-10-24T10:00:00Z', duration_sec: 900, starred: false, archived: false, active: false, tags: [] },
];
const COUNTS = { all: 2, group: 1, notes: 0, starred: 1, active: 0, archived: 1, by_agent_type: { claude: 1, codex: 1 }, tags: [{ id: 7, name: 'Release', color: '#2b6cb0', count: 1 }] };


(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const emptyLine = () => ev(`(document.querySelector('.dt-empty, .list-empty, .empty-state') || {}).textContent || document.body.innerText.match(/Search failed|Loading chats|No chat matches/)?.[0] || ''`);
    const search = async value => { await ev(`(() => { const q = document.querySelector('.inbox-folder-toolbar input[type=search]'); q.value = ${JSON.stringify(value)}; q.dispatchEvent(new Event('input', { bubbles: true })); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`); await settle(900); };
    const openFolder = async (key, mobile, title) => {
        if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        else await ev(`document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
        await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length >= 1 && !!document.querySelector('.inbox-folder-toolbar')`, `the ${title} page`, 10000); await settle(300);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-inbox-chats-filters')) localStorage.removeItem(k); } catch {} true`);
            await ev(`(() => { const R = window.fetch; window.__hist = [];
                window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url.pathname === '/api/sessions/history/counts') return json(${JSON.stringify(COUNTS)});
                    if (url.pathname === '/api/sessions/history') { const q = url.searchParams.get('q') || url.searchParams.get('search') || ''; window.__hist.push(Object.fromEntries(url.searchParams));
                        if (q === 'BROKEN') return json({ error: 'search_failed', detail: 'Search failed: try other words' }, 400);
                        if (q) return json({ sessions: [Object.assign({}, ${JSON.stringify(ROWS[0])}, { snippet: 'ticket PLUM-4471 is about the billing deploy' })], total: 1, page: 1, page_size: 50 });
                        return json({ sessions: ${JSON.stringify(ROWS)}, total: 2, page: 1, page_size: 50 }); }
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            await openFolder('chats', mobile, 'All chats');
            await search('PLUM-4471');
            const body = () => ev(`document.body.innerText`);
            check(`${label}: a search for PLUM-4471 shows the hit line of the chat`, /ticket PLUM-4471 is about the billing deploy/.test(await body()), (await body()).slice(0, 200));
            await search('BROKEN');
            check(`${label}: a search the server refuses says "Search failed", not "Loading chats"`, /Search failed/.test(await body()) && !/Loading chats/.test(await body()), (await body()).slice(0, 200));
            await search('PLUM-4471');
            check(`${label}: the next search works again`, /ticket PLUM-4471 is about the billing deploy/.test(await body()) && !/Search failed/.test(await body()));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox chat search checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
