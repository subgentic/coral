// The Inbox's Goals folder has the shared list toolbar (#8596, goal #62; UI/UX #8589 section 9): the search box, the Filters icon in the same row to its right, the state pills, and in the Filters panel Team, Driver,
// Updated since and Sort, the chips of what is on and "N on" on the icon; the filters are kept in the browser per folder; the folder list (the sidebar) is not touched. At 1280 and at 390, where the pills are one
// select and the search keeps at least 10rem. The goals are stood in at GET /api/goals. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');

const GOALS = [
    { id: 1, board_id: 'team-a', title: 'Ship the importer', outcome: 'Importer is live', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-20T10:00:00Z', rollup: { done: 2, active: 1, blocked: 0, queued: 1 } },
    { id: 2, board_id: 'team-a', title: 'Cut the cold start', outcome: 'Start under 2 s', state: 'blocked', driver: 'Backend Dev', updated_at: '2026-10-22T10:00:00Z', rollup: { done: 0, active: 0, blocked: 2, queued: 0 } },
    { id: 3, board_id: 'team-b', title: 'Plan the migration', outcome: 'A plan reviewed', state: 'proposed', driver: 'Orchestrator', updated_at: '2026-10-24T10:00:00Z', rollup: { done: 0, active: 0, blocked: 0, queued: 3 } },
    { id: 4, board_id: 'team-b', title: 'Write the guide', outcome: 'Docs merged', state: 'active', driver: 'Docs Writer', updated_at: '2026-10-25T10:00:00Z', rollup: { done: 1, active: 1, blocked: 0, queued: 0 } },
    { id: 5, board_id: 'team-b', title: 'Close the old board', outcome: 'Old board archived', state: 'done', driver: 'Orchestrator', updated_at: '2026-10-26T10:00:00Z', rollup: { done: 4, active: 0, blocked: 0, queued: 0 } },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const titles = () => ev(`[...document.querySelectorAll('button.dt-primary')].filter(b => b.getClientRects().length).map(b => (b.querySelector('.dt-mail-title') || b).textContent.trim()).sort()`); // a phone's row is a mail row (#9583): its button holds the title, the outcome and the time; the title is the name
    const folders = async () => (await ev(`${FOLDER_ROWS}.map(r => /^Goals/.test(r) ? r : r.replace(/\\d+/g, '')).join('|')`)); // the Goals row keeps its count; every other row's count arrives on its own time (a slow runner: Windows), so the check is on the names // the Artifacts count arrives on its own time (after the folder opens, on a slow runner): it is not what this check is about
    const geometry = () => ev(`(() => { const r = document.querySelector('.inbox-folder-toolbar .list-bar-search-row'); if (!r) return null; const q = r.querySelector('input[type=search]'), t = r.querySelector('.list-bar-toggle'); if (!q || !t) return { q: !!q, t: !!t };
        const a = q.getBoundingClientRect(), b = t.getBoundingClientRect(), p = r.querySelector('.team-tb-pills'), s = r.querySelector('.team-tb-select');
        const vis = e => !!e && e.getClientRects().length > 0;
        return { qName: q.getAttribute('aria-label'), sameRow: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 6, right: b.left >= a.right - 1, searchW: Math.round(a.width), pills: vis(p), select: vis(s), toggleName: t.getAttribute('aria-label'), vw: innerWidth, over: document.documentElement.scrollWidth - innerWidth }; })()`);
    const pick = key => ev(`(() => { const s = document.querySelector('.inbox-folder-toolbar .team-tb-select'); if (s && s.getClientRects().length) { s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
        const b = [...document.querySelectorAll('.team-tb-pills .goals-chip')].find(x => x.dataset.filter === ${JSON.stringify(key)}); b.click(); return true; })()`);
    const setField = (id, value) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`try { localStorage.removeItem('coral-inbox-goals-filters'); } catch {} true`);
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => /\\/api\\/goals(\\?|$)/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ goals: ${JSON.stringify(GOALS)} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            await waitFor(`(rows => /Goals5/.test(rows.join('|')) && ['All chats', 'Board history', 'With notes', 'Starred', 'Active now', 'Archived'].every(n => rows.some(r => r.startsWith(n) && /\\d/.test(r.slice(n.length)))))(${FOLDER_ROWS})`, 'every chat folder shows its count (the first snapshot is taken after they arrive: Windows CI showed them blank before and 0 after)', 15000);
            const before = await folders();
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); if (s) { s.value = 'goals'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="goals"]').click(); true`);
            await waitFor(`document.querySelectorAll('button.dt-primary').length >= 5`, 'five goals', 10000); await settle(300);

            check(`${label}: ${label === '390' ? 'opening the folder does not put the keyboard on the search box: a phone starts at the first row or the heading (#9985)' : "opening the folder puts the focus on the page's search box, not on the heading"}`, await ev(`(() => { const a = document.activeElement; const inSearch = !!a && a.matches('input[type=search]') && !!a.closest('.inbox-folder-toolbar'); return ${label === '390' ? '!a || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)' : 'inSearch'}; })()`), await ev(`document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)`));
            const g = await geometry();
            check(`${label}: the Goals page has a search box named "Search goals" and the Filters icon in the same row, to its right`, g && g.qName === 'Search goals' && g.sameRow && g.right && /Filters/.test(g.toggleName), JSON.stringify(g));
            if (mobile) check(`${label}: the pills are not in the row (one select in the Filters sheet since #8700), the search keeps at least 10rem, nothing is wider than the screen`, g && !g.select && !g.pills && g.searchW >= 160 && g.over <= 0, JSON.stringify(g));
            else check(`${label}: the state pills are in the row (All, Active, Blocked, Proposed, Done) with their counts`, g && g.pills && (await ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.textContent.trim()).join('|')`)) === 'All 5|Active 2|Blocked 1|Proposed 1|Done 1');

            await pick('blocked'); await settle(300);
            check(`${label}: the Blocked pill shows only the blocked goal`, JSON.stringify(await titles()) === JSON.stringify(['Cut the cold start']), JSON.stringify(await titles()));
            await pick('all'); await settle(300);

            await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(200);
            const labels = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-field-label')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).join('|')`);
            check(`${label}: the Filters panel has Team, Driver, Updated since and Sort`, /Team/.test(labels) && /Driver/.test(labels) && /Updated since/.test(labels) && /Sort/.test(labels), labels);
            check(`${label}: no label of the Filters panel wraps (each sits above its box)`, await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-menu .list-bar-field-label')].filter(e => e.getClientRects().length).every(e => e.getBoundingClientRect().height < 22 && e.getBoundingClientRect().width >= 110)`));
            await setField('inbox-goals-team', 'team-b'); await settle(400);
            const chipText = () => ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-text')].map(e => e.textContent).join('|')`);
            check(`${label}: a Team filter shows only that team's goals, as a chip "Team: team-b"`, JSON.stringify(await titles()) === JSON.stringify(['Close the old board', 'Plan the migration', 'Write the guide']) && (await chipText()) === 'Team: team-b', JSON.stringify([await titles(), await chipText()]));
            check(`${label}: the icon says one filter is on`, /1 on/.test(await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').getAttribute('aria-label')`)));
            await setField('inbox-goals-driver', 'Orchestrator'); await settle(400);
            check(`${label}: Team and Driver together narrow further`, JSON.stringify(await titles()) === JSON.stringify(['Close the old board', 'Plan the migration']), JSON.stringify(await titles()));
            check(`${label}: the filters are kept in the browser for the folder`, /team-b/.test(await ev(`localStorage.getItem('coral-inbox-goals-filters') || ''`)));
            check(`${label}: the folder list (the sidebar) is as it was`, (await folders()) === before, before + ' vs ' + (await folders()));

            await ev(`document.querySelector('.inbox-folder-toolbar input[type=search]').focus(); true`);
            await ev(`(() => { const q = document.querySelector('.inbox-folder-toolbar input[type=search]'); q.value = 'migration'; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`[...document.querySelectorAll('button.dt-primary')].filter(b => b.getClientRects().length).length === 1`, 'the search narrows', 6000);
            check(`${label}: the search narrows inside the filters`, JSON.stringify(await titles()) === JSON.stringify(['Plan the migration']), JSON.stringify(await titles()));
            await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-all')].forEach(b => b.click()); true`); await settle(500);
            check(`${label}: Clear all gives every goal back`, (await titles()).length === 5, JSON.stringify(await titles()));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox Goals toolbar checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
