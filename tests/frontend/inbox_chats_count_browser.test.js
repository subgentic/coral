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
                    if (url.pathname === '/api/sessions/history') { window.__hist.push(Object.fromEntries(url.searchParams)); if (window.__slow) return new Promise(res => setTimeout(() => res(json({ sessions: rows, total: rows.length, page: 1, page_size: 50 })), window.__slow)); return json({ sessions: rows, total: rows.length, page: 1, page_size: 50 }); }
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
            await openFolder('chats', mobile, 'All chats');
            const reads = () => ev(`window.__hist.filter(p => p.type === 'agent' && !p.date_from).length`);
            check(`${label}: the first read shows the one chat that was indexed`, (await rowsShown()) === 1, String(await rowsShown()));
            await ev(`window.__n = 2; window.__slow = 1200; window.__sawLoading = false; window.__sawRows = []; new MutationObserver(() => { window.__sawRows.push(document.querySelectorAll('button.dt-primary, button.dt-person').length); if (/Loading chats/.test(document.body.innerText)) window.__sawLoading = true; }).observe(document.body, { childList: true, subtree: true, characterData: true }); true`);
            const before = await reads();
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); const g = await import((window.__coralStatic || '/static/') + 'sidebar_groups.js'); await m.loadChatCounts(() => g.refreshGroupTable('hub-inbox')); return true; })()`);
            await settle(400);
            check(`${label}: while the list is read again the old chat stays on screen, with no "Loading chats"`, (await rowsShown()) === 1 && !(await ev(`window.__sawLoading`)), `${await rowsShown()} ${await ev('window.__sawLoading')}`);
            await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length === 2`, 'the list read again with the second chat', 8000).catch(() => {});
            check(`${label}: after the counts say 2 the list shows 2 chats, not 1`, (await rowsShown()) === 2, String(await rowsShown()));
            check(`${label}: it was never empty and never said "Loading chats" on the way`, !(await ev(`window.__sawLoading`)) && !(await ev(`window.__sawRows.includes(0)`)), JSON.stringify(await ev(`window.__sawRows`)));
            check(`${label}: the re-read was one read`, (await reads()) === before + 1, `${before} then ${await reads()}`);
            await ev(`window.__slow = 0; true`);
            // a list kept from an earlier look is read again once it is old, with no counts read at all (#10262: after a restart the folder kept the one chat it was first opened with)
            await ev(`window.__n = 1; window.__stuck = false; (async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); m.resetChatLists(); })(); true`); await openFolder('chats-group', mobile, 'Board history'); await openFolder('chats', mobile, 'All chats'); await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length === 1`, 'the list with one chat', 8000).catch(() => {});
            await ev(`window.__n = 2; true`);
            const staleBefore = await reads();
            await ev(`(async () => { const g = await import((window.__coralStatic || '/static/') + 'sidebar_groups.js'); g.refreshGroupTable('hub-inbox'); return true; })()`); await settle(300);
            check(`${label}: a list that is not old is not read again by a redraw`, (await reads()) === staleBefore, `${staleBefore} then ${await reads()}`);
            await ev(`window.__realNow = Date.now; Date.now = () => window.__realNow() + 25000; (async () => { const g = await import((window.__coralStatic || '/static/') + 'sidebar_groups.js'); g.refreshGroupTable('hub-inbox'); })(); true`);
            await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length === 2`, 'the old list read again with the second chat', 8000).catch(() => {});
            await ev(`Date.now = window.__realNow; true`);
            check(`${label}: an old list shows the chat that came in since it was read`, (await rowsShown()) === 2, String(await rowsShown()));
            // a count that stays different from the list's total reads it once, not at every counts read
            const beforeStuck = await reads();
            await ev(`window.__stuck = true; (async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); const g = await import((window.__coralStatic || '/static/') + 'sidebar_groups.js'); for (let i = 0; i < 4; i++) { await m.loadChatCounts(() => g.refreshGroupTable('hub-inbox')); await new Promise(r => setTimeout(r, 90)); } })(); true`);
            await settle(1500); const afterStuck = await reads();
            check(`${label}: a count that stays different reads the list once, however many counts reads there are`, afterStuck === beforeStuck + 1, `${beforeStuck} then ${afterStuck}`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); const g = await import((window.__coralStatic || '/static/') + 'sidebar_groups.js'); for (let i = 0; i < 4; i++) { await m.loadChatCounts(() => g.refreshGroupTable('hub-inbox')); await new Promise(r => setTimeout(r, 90)); } return true; })()`);
            await settle(1500);
            check(`${label}: a count that stays different does not read the list again and again`, (await reads()) === afterStuck, `${afterStuck} then ${await reads()}`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox chats count checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
