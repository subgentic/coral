// The shared list toolbar never changes height when a filter is switched on (#9078, the operator: an active chip "No goal x" wrapped under the toolbar and the page jumped). The Inbox's Goals folder at 1280 and 390:
// the toolbar's box is the same height with no filter, with one chip and with two; a chip is inside the search row, after the pills and before the Filters icon, and readable (128 px or more) with "+N" for the rest at 1280; at 390 the row has no chips and the Filters icon carries the number; nothing is wider than the screen.
// The goals are stood in at GET /api/goals. Drives Chrome over CDP against the isolated dev server.
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
    const setField = (id, value) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const bar = () => ev(`(() => { const b = document.querySelector('.inbox-folder-toolbar'), r = b.querySelector('.list-bar-search-row'), t = r.querySelector('.list-bar-toggle');
        const chips = [...b.querySelectorAll('.list-bar-chip:not(.list-bar-chip-all):not(.list-bar-chip-more), .team-tb-chip:not(.team-tb-chip-more)')].filter(c => c.getClientRects().length);
        const pills = r.querySelector('.team-tb-pills'), tr = t.getBoundingClientRect();
        const first = chips[0], more = [...b.querySelectorAll('.list-bar-chip-more')].find(c => c.getClientRects().length), badge = t.querySelector('.display-badge');
        const extra = { chipW: first ? Math.round(first.getBoundingClientRect().width) : 0, more: more ? more.textContent.trim() : '', badge: badge && !badge.hidden ? badge.textContent.trim() : '', label: t.getAttribute('aria-label') };
        return { ...extra, h: Math.round(b.getBoundingClientRect().height), rowH: Math.round(r.getBoundingClientRect().height), chips: chips.length, inRow: chips.every(c => r.contains(c)),
            beforeIcon: chips.every(c => c.getBoundingClientRect().right <= tr.left + 1), afterPills: !pills || !pills.getClientRects().length || chips.every(c => c.getBoundingClientRect().left >= pills.getBoundingClientRect().right - 1),
            sameLine: chips.every(c => Math.abs((c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2) - (tr.top + tr.height / 2)) < 8), over: Math.round(document.documentElement.scrollWidth - innerWidth) }; })()`);
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
            await waitFor(`/Goals5/.test(${FOLDER_ROWS}.join('|')) && /All chats\\d/.test(${FOLDER_ROWS}.join('|'))`, 'the folder counts', 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); if (s) { s.value = 'goals'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="goals"]').click(); true`);
            await waitFor(`document.querySelectorAll('button.dt-primary').length >= 5`, 'five goals', 10000); await settle(300);
            // the Filters panel stays shut: the toolbar's own height is what is measured (the fields are set while it is hidden)
            const none = await bar();
            await setField('inbox-goals-team', 'team-b'); await settle(400);
            const one = await bar();
            await setField('inbox-goals-driver', 'Orchestrator'); await settle(400);
            const two = await bar();
            check(`${label}: no filter on: no chip, no number on the Filters icon`, none.chips === 0 && none.badge === '', JSON.stringify(none));
            if (!mobile) {
                check(`${label}: one chip is in the search row, after the pills and before the Filters icon, on the icon's line, readable (128 px or more), no "+N"`, one.chips === 1 && one.inRow && one.beforeIcon && one.afterPills && one.sameLine && one.chipW >= 128 && one.more === '', JSON.stringify(one));
                check(`${label}: two filters: still one readable chip and "+1" in the row`, two.chips === 1 && two.inRow && two.beforeIcon && two.afterPills && two.sameLine && two.chipW >= 128 && two.more === '+1', JSON.stringify(two));
            } else check(`${label}: no room in the row: no chip, no "+N"; the Filters icon says 1, then 2`, one.chips === 0 && two.chips === 0 && one.more === '' && two.more === '', JSON.stringify([one, two]));
            check(`${label}: the Filters icon carries the number of filters on (a number, not a dot): 1 then 2`, one.badge === '1' && two.badge === '2' && /2 on/.test(two.label || ''), JSON.stringify([one.badge, two.badge, two.label]));
            check(`${label}: the toolbar is the same height with no filter, one chip and two (${none.h}, ${one.h}, ${two.h})`, one.h === none.h && two.h === none.h && one.rowH === none.rowH && two.rowH === none.rowH, JSON.stringify([none, one, two]));
            check(`${label}: nothing is wider than the screen with chips on`, one.over <= 0 && two.over <= 0, `${one.over}, ${two.over}`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} toolbar chip checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
