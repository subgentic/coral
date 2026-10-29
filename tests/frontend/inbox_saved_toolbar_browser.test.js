// The Inbox's Saved folder has the shared list toolbar (#8602, goal #62; UI/UX #8589 section 9): the search box, the Open | Done pills and the Filters icon in one row (the icon to the right of the search), and in the
// Filters panel Type, Team, From, Saved since and Sort; the chips, "N on" on the icon, the filters kept in the browser. The sidebar (the folder list) is not touched. At 1280 and at 390, where the pills are one select
// and the search keeps at least 10rem. GET /api/saved is stood in (it answers q, kind and conv as the server does, and its totals are the whole list's; the Team and Saved since filters are the page's). Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');

const ITEMS = [
    { id: 1, kind: 'agent', ref: 'sid-a', key: '0123456789abcdef0123', title: 'Frontend Dev', snippet: 'About the importer', saved_at: '2026-10-20T10:00:00Z', team: 'team-a' },
    { id: 2, kind: 'board', ref: 'team-a', key: '1001', title: 'team-a board', snippet: 'Cold start numbers', saved_at: '2026-10-22T10:00:00Z', team: 'team-a' },
    { id: 3, kind: 'board', ref: 'team-b', key: '1002', title: 'team-b board', snippet: 'Migration plan', saved_at: '2026-10-23T10:00:00Z', done_at: '2026-10-24T10:00:00Z', team: 'team-b' },
    { id: 4, kind: 'agent', ref: 'sid-b', key: '0123456789abcdef0124', title: 'Backend Dev', snippet: 'Writing the guide', saved_at: '2026-10-25T10:00:00Z', team: 'team-b' },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const rows = () => ev(`[...document.querySelectorAll('button.dt-primary')].filter(b => b.getClientRects().length).map(b => b.textContent.trim()).sort()`);
    const folders = () => ev(`${FOLDER_ROWS}.join('|')`);
    const geometry = () => ev(`(() => { const r = document.querySelector('.inbox-folder-toolbar .list-bar-search-row'); if (!r) return null; const q = r.querySelector('input[type=search]'), t = r.querySelector('.list-bar-toggle'); if (!q || !t) return { q: !!q, t: !!t };
        const a = q.getBoundingClientRect(), b = t.getBoundingClientRect(), vis = e => !!e && e.getClientRects().length > 0;
        return { qName: q.getAttribute('aria-label'), sameRow: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 6, right: b.left >= a.right - 1, searchW: Math.round(a.width), pills: vis(r.querySelector('.team-tb-pills')), select: vis(r.querySelector('.team-tb-select')), toggleName: t.getAttribute('aria-label'), over: document.documentElement.scrollWidth - innerWidth }; })()`);
    const pick = key => ev(`(() => { const s = document.querySelector('.inbox-folder-toolbar .team-tb-select'); if (s && s.getClientRects().length) { s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
        const b = [...document.querySelectorAll('.team-tb-pills .goals-chip')].find(x => x.dataset.filter === ${JSON.stringify(key)}); b.click(); return true; })()`);
    const setField = (id, value) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const chipText = () => ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-text')].map(e => e.textContent).join('|')`);
    const waitRows = (n, what) => waitFor(`[...document.querySelectorAll('button.dt-primary')].filter(b => b.getClientRects().length).length === ${n}`, what, 8000);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady('startup', 'liveList', 'settings');
            await ev(`try { localStorage.removeItem('coral-saved-filters'); } catch {} true`);
            await ev(`(() => { const R = window.fetch; const ITEMS = ${JSON.stringify(ITEMS)};
                window.fetch = (u, o) => { const url = new URL(String(u), location.href); if (url.pathname !== '/api/saved') return R(u, o);
                    const q = (url.searchParams.get('q') || '').toLowerCase(), kind = url.searchParams.get('kind'), conv = url.searchParams.get('conv');
                    const list = ITEMS.filter(i => (!q || (i.title + ' ' + i.snippet).toLowerCase().includes(q)) && (!kind || i.kind === kind) && (!conv || i.ref === conv));
                    return Promise.resolve(new Response(JSON.stringify({ items: list, open: ITEMS.filter(i => !i.done_at).length, done: ITEMS.filter(i => i.done_at).length }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); if (s) { s.value = 'saved'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="saved"]').click(); true`);
            await waitRows(3, 'the three open saved messages');
            await waitFor(`/Saved3/.test(${FOLDER_ROWS}.join('|')) && /All chats/.test(${FOLDER_ROWS}.join('|'))`, 'the folder counts', 10000);
            const before = await folders();

            check(`${label}: ${label === '390' ? 'opening the folder does not put the keyboard on the search box: a phone starts at the first row or the heading (#9985)' : "opening the folder puts the focus on the page's search box, not on the heading"}`, await ev(`(() => { const a = document.activeElement; const inSearch = !!a && a.matches('input[type=search]') && !!a.closest('.inbox-folder-toolbar'); return ${label === '390' ? '!a || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)' : 'inSearch'}; })()`), await ev(`document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)`));
            const g = await geometry();
            check(`${label}: the Saved page has a search box named "Search saved messages" and the Filters icon in the same row, to its right`, g && g.qName === 'Search saved messages' && g.sameRow && g.right && /Filters/.test(g.toggleName), JSON.stringify(g));
            if (mobile) check(`${label}: the Open | Done pills are not in the row (one select in the Filters sheet since #8700), the search keeps at least 10rem, nothing is wider than the screen`, g && !g.select && !g.pills && g.searchW >= 160 && g.over <= 0, JSON.stringify(g));
            else check(`${label}: the pills Open and Done are in the row, with their counts`, g && g.pills && (await ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.textContent.trim()).join('|')`)) === 'Open 3|Done 1');
            check(`${label}: the page's old Show chips are gone (the pills are the toolbar's)`, !(await ev(`!!document.querySelector('[data-action="inbox-saved-chip"], .group-chips')`)));

            await pick('done'); await waitRows(1, 'the done tab');
            check(`${label}: the Done pill shows the one done message`, (await rows()).length === 1);
            await pick('open'); await waitRows(3, 'the open tab');

            await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(200);
            const labels = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-field-label')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).join('|')`);
            check(`${label}: the Filters panel has Type, Team, Saved since and Sort (and From)`, /Type/.test(labels) && /Team/.test(labels) && /Saved since/.test(labels) && /Sort/.test(labels) && /From/.test(labels), labels);
            check(`${label}: no label of the Filters panel wraps, and they share one wide column (7.5rem)`, await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-menu .list-bar-field-label')].filter(e => e.getClientRects().length).every(e => e.getBoundingClientRect().height < 22 && e.getBoundingClientRect().width >= 110)`));
            await setField('inbox-saved-kind', 'agent'); await waitRows(2, 'the agent chats');
            check(`${label}: Type narrows (the server's filter): the two agent chats, chip "Type: Agent chat"`, (await rows()).length === 2 && (await chipText()) === 'Type: Agent chat', await chipText());
            await setField('inbox-saved-team', 'team-b'); await waitRows(1, 'one team-b agent chat');
            check(`${label}: Team narrows (the page's filter) with a chip, and the icon says 2 on`, (await rows()).length === 1 && /Team: team-b/.test(await chipText()) && /2 on/.test(await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').getAttribute('aria-label')`)), await chipText());
            await setField('inbox-saved-from', '2026-10-26'); await waitRows(0, 'nothing saved since the 26th');
            check(`${label}: Saved since a day nothing was saved on shows the empty line`, /No saved messages match/.test(await ev(`document.body.textContent`)));
            check(`${label}: the filters are kept in the browser, without the search words`, /team-b/.test(await ev(`localStorage.getItem('coral-saved-filters') || ''`)));
            check(`${label}: the folder list (the sidebar) is as it was`, (await folders()) === before, before + ' vs ' + (await folders()));
            await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-all')].forEach(b => b.click()); true`); await waitRows(3, 'every open message again');
            check(`${label}: Clear all gives the open messages back`, (await rows()).length === 3);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox Saved toolbar checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
