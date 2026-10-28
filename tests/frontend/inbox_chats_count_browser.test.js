// Inbox > All chats after a restart (#10197): the first read of the list came while the history index was still filling in (1 chat), the counts read then said 2, and the header said 2 over a
// list of 1 for good. The list is read again when its folder's count moves, once for each count (a count that stays different does not read it again and again). Drives Chrome over CDP.
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
    const rowsShown = () => ev(`document.querySelectorAll('button.dt-primary, button.dt-person').length`);
    const openFolder = async (key, mobile, title) => {
        if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        else await ev(`document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
        await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length >= 1 && !!document.querySelector('.inbox-folder-toolbar')`, `the ${title} page`, 10000); await settle(300);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(() => { const R = window.fetch; window.__hist = []; window.__n = 1; window.__stuck = false;
                window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    const rows = ${JSON.stringify(ROWS)}.slice(0, window.__n);
                    if (url.pathname === '/api/sessions/history/counts') return json(Object.assign({}, ${JSON.stringify(COUNTS)}, { all: window.__stuck ? 5 : window.__n }));
                    if (url.pathname === '/api/sessions/history') { window.__hist.push(Object.fromEntries(url.searchParams)); return json({ sessions: rows, total: rows.length, page: 1, page_size: 50 }); }
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
            await openFolder('chats', mobile, 'All chats');
            const reads = () => ev(`window.__hist.filter(p => p.type === 'agent' && !p.date_from).length`);
            check(`${label}: the first read shows the one chat that was indexed`, (await rowsShown()) === 1, String(await rowsShown()));
            await ev(`window.__n = 2; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); const g = await import((window.__coralStatic || '/static/') + 'sidebar_groups.js'); await m.loadChatCounts(() => g.refreshGroupTable('hub-inbox')); return true; })()`);
            await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length === 2`, 'the list read again with the second chat', 8000).catch(() => {});
            check(`${label}: after the counts say 2 the list shows 2 chats, not 1`, (await rowsShown()) === 2, String(await rowsShown()));
            // a count that stays different from the list's total reads it once, not at every counts read
            await ev(`window.__stuck = true; (async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); for (let i = 0; i < 4; i++) await m.loadChatCounts(() => {}); })(); true`);
            await settle(1500); const afterStuck = await reads();
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); for (let i = 0; i < 4; i++) await m.loadChatCounts(() => {}); return true; })()`);
            await settle(1500);
            check(`${label}: a count that stays different does not read the list again and again`, (await reads()) === afterStuck, `${afterStuck} then ${await reads()}`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox chats count checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
