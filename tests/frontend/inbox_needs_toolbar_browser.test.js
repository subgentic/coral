// The Inbox's Needs you folder has the shared list toolbar (#8604, goal #62; UI/UX #8589 section 9): the search box, the kind pills (All, Permission, Question, Needs input) and the Filters icon in one row (the icon to the
// right of the search), and in the Filters panel Team, Agent, Waiting longer than and Sort; chips, "N on" on the icon, the filters kept in the browser, the folder list (the sidebar) not touched, the longest-waiting
// agent first by default. At 1280 and at 390, where the pills are one select and the search keeps at least 10rem. Four agents are made to wait through the live list. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const names = () => ev(`[...document.querySelectorAll('#group-table-view button.dt-primary, #group-table-view button.dt-person')].filter(b => b.getClientRects().length).map(b => b.textContent.trim())`);
    const folders = () => ev(`${FOLDER_ROWS}.join('|')`);
    const geometry = () => ev(`(() => { const r = document.querySelector('.inbox-folder-toolbar .list-bar-search-row'); if (!r) return null; const q = r.querySelector('input[type=search]'), t = r.querySelector('.list-bar-toggle'); if (!q || !t) return { q: !!q, t: !!t };
        const a = q.getBoundingClientRect(), b = t.getBoundingClientRect(), vis = e => !!e && e.getClientRects().length > 0;
        return { qName: q.getAttribute('aria-label'), sameRow: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 6, right: b.left >= a.right - 1, searchW: Math.round(a.width), pills: vis(r.querySelector('.team-tb-pills')), select: vis(r.querySelector('.team-tb-select')), toggleName: t.getAttribute('aria-label'), over: document.documentElement.scrollWidth - innerWidth }; })()`);
    const pick = key => ev(`(() => { const s = document.querySelector('.inbox-folder-toolbar .team-tb-select'); if (s && s.getClientRects().length) { s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
        const b = [...document.querySelectorAll('.team-tb-pills .goals-chip')].find(x => x.dataset.filter === ${JSON.stringify(key)}); b.click(); return true; })()`);
    const setField = (id, value) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const chipText = () => ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-text')].map(e => e.textContent).join('|')`);
    const waitNames = (n, what) => waitFor(`[...document.querySelectorAll('#group-table-view button.dt-primary, #group-table-view button.dt-person')].filter(b => b.getClientRects().length).length === ${n}`, what, 8000);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`try { localStorage.removeItem('coral-inbox-needs-filters'); } catch {} true`);
            await ev(`(() => { window.__m.add('Frontend Dev', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'fe-id' }); window.__m.add('Backend Dev', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'be-id' });
                window.__m.add('QA Engineer', 'C', 4, { sleeping: false, board_project: 'team-b', session_id: 'qa-id' }); window.__m.add('Docs Writer', 'D', 4, { sleeping: false, board_project: 'team-b', session_id: 'dw-id' }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 4`, 'four agents', 8000);
            await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); const W = { 'fe-id': ['permission', ago(3)], 'be-id': ['question', ago(30)], 'qa-id': ['plan', ago(120)], 'dw-id': ['', ''] };
                window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: W[s.session_id][0], waiting_since: W[s.session_id][1] }));
                (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); if (s) { s.value = 'needs'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="needs"]').click(); true`);
            await waitNames(4, 'the four waiting agents'); await settle(300);
            const before = await folders();

            check(`${label}: opening the folder puts the focus on the page's search box`, await ev(`(() => { const a = document.activeElement; return !!a && a.matches('input[type=search]') && !!a.closest('.inbox-folder-toolbar'); })()`));
            const g = await geometry();
            check(`${label}: the Needs you page has a search box named "Search needs you" and the Filters icon in the same row, to its right`, g && g.qName === 'Search needs you' && g.sameRow && g.right && /Filters/.test(g.toggleName), JSON.stringify(g));
            if (mobile) check(`${label}: the pills are not in the row (one select in the Filters sheet since #8700), the search keeps at least 10rem, nothing is wider than the screen`, g && !g.select && !g.pills && g.searchW >= 160 && g.over <= 0, JSON.stringify(g));
            else check(`${label}: the pills All, Permission, Question and Needs input are in the row, with their counts`, g && g.pills && (await ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.textContent.trim()).join('|')`)) === 'All 4|Permission 1|Question 1|Needs input 2');
            check(`${label}: the agent waiting longest is first`, (await names())[0] === 'QA Engineer', JSON.stringify(await names()));

            await pick('permission'); await waitNames(1, 'the permission pill');
            check(`${label}: the Permission pill shows the one agent waiting on a permission`, JSON.stringify(await names()) === JSON.stringify(['Frontend Dev']), JSON.stringify(await names()));
            await pick('other'); await waitNames(2, 'the Needs input pill');
            check(`${label}: the Needs input pill shows the plan and the one with no kind`, (await names()).length === 2);
            await pick('all'); await waitNames(4, 'all four again');

            await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(200);
            const labels = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-field-label')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).join('|')`);
            check(`${label}: the Filters panel has Team, Agent, Waiting longer than and Sort`, labels.replace(/^Show\|/, '') === 'Team|Agent|Waiting longer than|Sort', labels);
            await setField('inbox-needs-team', 'team-b'); await waitNames(2, 'team-b');
            check(`${label}: a Team filter shows only that team's agents, as a chip, and the icon says one is on`, (await chipText()) === 'Team: team-b' && /1 on/.test(await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').getAttribute('aria-label')`)), await chipText());
            await setField('inbox-needs-longer', '60'); await waitNames(1, 'waiting more than an hour');
            check(`${label}: Waiting longer than an hour narrows further, to the one that has waited two`, JSON.stringify(await names()) === JSON.stringify(['QA Engineer']) && /Waiting longer than 1 hour/.test(await chipText()), JSON.stringify([await names(), await chipText()]));
            check(`${label}: the filters are kept in the browser for the folder`, /team-b/.test(await ev(`localStorage.getItem('coral-inbox-needs-filters') || ''`)));
            check(`${label}: the folder list (the sidebar) is as it was`, (await folders()) === before, before + ' vs ' + (await folders()));
            await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-all')].forEach(b => b.click()); true`); await waitNames(4, 'all four after Clear all');
            await setField('inbox-needs-sort', 'newest'); await settle(300);
            check(`${label}: Sort by least waiting puts the agent waiting least first`, (await names())[0] === 'Frontend Dev', JSON.stringify(await names()));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox Needs you toolbar checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
