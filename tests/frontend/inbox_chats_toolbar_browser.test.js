// The Inbox's chat folders have the shared list toolbar (#8603, goal #62; UI/UX #8589 section 9): on each folder's page the search box and the Filters icon in the same row, to its right; in the panel the fields the
// folder does not already decide (CLI, Agent, Tag, Dates; a CLI folder has no CLI, Board history only the dates), as chips with "N on" on the icon; they become the history read's parameters and the folder's own rule
// (Starred, Archived, a CLI, a board's history) stays; they are kept in the browser per folder; the sidebar (the folder list) is not touched. At 1280 and at 390. GET /api/sessions/history and its counts are stood in
// (the requests are recorded). Drives Chrome over CDP against the isolated dev server.
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
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const folders = () => ev(`${FOLDER_ROWS}.join('|')`);
    const geometry = () => ev(`(() => { const r = document.querySelector('.inbox-folder-toolbar .list-bar-search-row'); if (!r) return null; const q = r.querySelector('input[type=search]'), t = r.querySelector('.list-bar-toggle'); if (!q || !t) return { q: !!q, t: !!t };
        const a = q.getBoundingClientRect(), b = t.getBoundingClientRect();
        return { qName: q.getAttribute('aria-label'), sameRow: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 6, right: b.left >= a.right - 1, searchW: Math.round(a.width), toggleName: t.getAttribute('aria-label'), over: document.documentElement.scrollWidth - innerWidth }; })()`);
    const labels = () => ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-field-label')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).join('|')`);
    const chipText = () => ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-text')].map(e => e.textContent).join('|')`);
    const lastRead = () => ev(`(window.__hist || []).slice(-1)[0] || null`);
    const readCount = () => ev(`(window.__hist || []).length`);
    const setField = (id, value, kind = 'change') => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event(${JSON.stringify(kind)}, { bubbles: true })); return true; })()`);
    const openFolder = async (key, mobile, title) => {
        if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        else await ev(`document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
        await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length >= 1 && !!document.querySelector('.inbox-folder-toolbar')`, `the ${title} page`, 10000); await settle(300);
    };
    const panel = async () => { if (!(await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').getAttribute('aria-expanded')`) === 'true')) { await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(200); } };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady('startup', 'liveList', 'settings');
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-inbox-chats-filters')) localStorage.removeItem(k); } catch {} true`);
            await ev(`(() => { const R = window.fetch; window.__hist = [];
                window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    if (url.pathname === '/api/sessions/history/counts') return json(${JSON.stringify(COUNTS)});
                    if (url.pathname === '/api/sessions/history') { window.__hist.push(Object.fromEntries(url.searchParams)); return json({ sessions: ${JSON.stringify(ROWS)}, total: 2, page: 1, page_size: 50 }); }
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            await openFolder('chats', mobile, 'All chats');
            await waitFor(`/All chats/.test(${FOLDER_ROWS}.join('|')) || !!document.querySelector('.view-list select')`, 'the folder counts', 10000);
            const before = await folders();

            check(`${label}: ${label === '390' ? 'opening the folder does not put the keyboard on the search box: a phone starts at the first row or the heading (#9985)' : "opening the folder puts the focus on the page's search box, not on the heading"}`, await ev(`(() => { const a = document.activeElement; return ${label === '390' ? '!a || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)' : "!!a && a.matches('input[type=search]') && !!a.closest('.inbox-folder-toolbar')"}; })()`), await ev(`document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)`));
            const g = await geometry();
            check(`${label}: All chats has a search box named "Search chats" and the Filters icon in the same row, to its right`, g && g.qName === 'Search chats' && g.sameRow && g.right && /Filters/.test(g.toggleName), JSON.stringify(g));
            if (mobile) check(`${label}: the search keeps at least 10rem and nothing is wider than the screen`, g && g.searchW >= 160 && g.over <= 0, JSON.stringify(g));
            await panel();
            check(`${label}: All chats' panel has CLI, Agent, Tag, From and To`, (await labels()) === 'CLI|Agent|Tag|From|To', await labels());

            await setField('inbox-chats-cli', 'codex'); await waitFor(`(window.__hist || []).some(p => p.source_types === 'codex')`, 'a read with the CLI', 6000);
            const r1 = await lastRead();
            check(`${label}: a CLI filter is the read's source_types, with the folder's own type kept, and a chip "CLI: Codex"`, r1.source_types === 'codex' && r1.type === 'agent' && (await chipText()) === 'CLI: Codex', JSON.stringify([r1, await chipText()]));
            check(`${label}: the icon says one filter is on`, /1 on/.test(await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').getAttribute('aria-label')`)));
            await setField('inbox-chats-tag', '7'); await waitFor(`(window.__hist || []).some(p => p.tag_ids === '7')`, 'a read with the tag', 6000);
            check(`${label}: a Tag filter is tag_ids, with the earlier filters kept`, (await lastRead()).tag_ids === '7' && (await lastRead()).source_types === 'codex' && /Tag: Release/.test(await chipText()), await chipText());
            await setField('inbox-chats-from', '2026-10-01'); await setField('inbox-chats-to', '2026-10-20');
            await waitFor(`(window.__hist || []).some(p => p.date_from === '2026-10-01' && p.date_to === '2026-10-20')`, 'a read with the dates', 6000);
            check(`${label}: the dates are date_from and date_to and one chip`, /Dates: 2026-10-01 to 2026-10-20/.test(await chipText()), await chipText());
            await setField('inbox-chats-agent', 'Frontend Dev', 'input'); await waitFor(`(window.__hist || []).some(p => p.agent_name === 'Frontend Dev')`, 'a read with the agent', 6000);
            check(`${label}: an Agent filter is agent_name`, (await lastRead()).agent_name === 'Frontend Dev');
            check(`${label}: the filters are kept in the browser for the folder`, /codex/.test(await ev(`localStorage.getItem('coral-inbox-chats-filters:chats') || ''`)));
            check(`${label}: the folder list (the sidebar) is as it was`, (await folders()) === before, before + ' vs ' + (await folders()));

            // another folder has its own set and its own memory; its own rule stays
            await openFolder('chats-starred', mobile, 'Starred'); await panel();
            check(`${label}: Starred starts with none of All chats' filters`, (await chipText()) === '', await chipText());
            await setField('inbox-chats-agent', 'QA Engineer', 'input'); await waitFor(`(window.__hist || []).some(p => p.agent_name === 'QA Engineer')`, 'a read in Starred', 6000);
            check(`${label}: Starred keeps its own rule (starred=1) beside the filter`, (await lastRead()).starred === '1' && (await lastRead()).agent_name === 'QA Engineer', JSON.stringify(await lastRead()));
            await openFolder('chats-cli-claude', mobile, 'Claude'); await panel();
            check(`${label}: a CLI folder has no CLI field: Agent, Tag, From, To`, (await labels()) === 'Agent|Tag|From|To', await labels());
            await openFolder('chats-group', mobile, 'Board history'); await panel();
            check(`${label}: Board history has the dates only`, (await labels()) === 'From|To', await labels());
            await setField('inbox-chats-from', '2026-10-05'); await waitFor(`(window.__hist || []).some(p => p.type === 'group' && p.date_from === '2026-10-05')`, 'a board read with the date', 6000);
            check(`${label}: its date is date_from beside type=group`, (await lastRead()).type === 'group' && (await lastRead()).date_from === '2026-10-05', JSON.stringify(await lastRead()));
            await openFolder('chats', mobile, 'All chats'); await panel();
            check(`${label}: coming back to All chats, its filters are still on`, /CLI: Codex/.test(await chipText()) && /Tag: Release/.test(await chipText()), await chipText());
            await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-all')].forEach(b => b.click()); true`); await settle(500);
            check(`${label}: Clear all takes them all off`, (await chipText()) === '', await chipText());
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox chats toolbar checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
