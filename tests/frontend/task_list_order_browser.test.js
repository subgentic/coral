// The task list at scale (#4716, UX's #4706 items 1 and 7): the default order puts open and active work first, then the finished tasks, newest first
// inside each part; a column the person chooses sorts the whole list as it always did; and in a narrow dock the header's Priority and Agent labels
// do not touch. With a thousand recent finished tasks the first 50 rows used to be all Finished. Drives Chrome over CDP through agent_view_harness.js
// against the isolated dev server; the board's tasks are answered by the test (task_list_golden_browser pins the rest of the list).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

// 40 recently finished tasks, and older open ones of every open status: the open ones are the oldest by created_at.
const done = Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, title: 'Done ' + i, status: i % 7 === 0 ? 'skipped' : 'completed', priority: 'medium', created_at: `2026-10-1${i % 9}T10:${String(i).padStart(2, '0')}:00Z` }));
const open = [
    { id: 1, title: 'Pending', status: 'pending', priority: 'low', created_at: '2026-09-01T10:00:00Z' },
    { id: 2, title: 'Running', status: 'in_progress', priority: 'high', assigned_to: 'Dev', claimed_at: '2026-09-02T10:00:00Z', created_at: '2026-09-02T10:00:00Z' },
    { id: 3, title: 'In review', status: 'review_pending', priority: 'medium', assigned_to: 'Dev', created_at: '2026-09-03T10:00:00Z' },
    { id: 4, title: 'Blocked', status: 'blocked', priority: 'medium', created_at: '2026-09-04T10:00:00Z' },
    { id: 5, title: 'Draft', status: 'draft', priority: 'low', created_at: '2026-09-05T10:00:00Z' },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            const T = window.T = { state: (await import(st + 'state.js')).state, tasks: await import(st + 'tasks.js') };
            T.state.currentSession = { name: 'solo', type: 'live', board_project: 'team-a', board_is_orchestrator: true, session_id: 'sid' }; T.state.currentAgentTasks = []; T.state.currentSubagents = [];
            const all = ${JSON.stringify([...done, ...open])};
            const real = window.fetch;
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href);
                if (/\\/api\\/board\\/[^/]+\\/tasks$/.test(p.pathname)) return Promise.resolve(new Response(JSON.stringify({ tasks: all, next_cursor: '', total_open: 5, total_completed: 40 }), { status: 200, headers: { 'content-type': 'application/json' } }));
                return real(u, o); };
            await T.tasks.loadBoardTasks('team-a'); return true; })()`);
        const ids = () => ev(`[...document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)')].map(r => Number(r.querySelector('.board-task-id').textContent.replace('#', '')))`);
        await waitFor(`document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length === 45`, 'the 45 rows');

        console.log('Columns put Status and the primary Task before the facts');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#board-task-list thead th')].map(h => h.querySelector('.dt-sort > span, .dt-head-text').textContent.trim())`),
            ['Status', 'Task', 'Priority', 'Type', 'Agent', 'Cost', 'Created']);
        assert.deepEqual(await ev(`[...document.querySelector('#board-task-list tbody tr').cells].map(c => c.dataset.key)`),
            ['status', 'id', 'priority', 'type', 'assignee', 'cost', 'created_at']);
        assert.equal(await ev(`(() => { const row = document.querySelector('#board-task-list tbody tr'); const primary = row.cells[1].querySelector('.dt-primary'); return row.querySelectorAll('.dt-primary').length === 1 && row.cells[1].querySelector('.board-task-id')?.textContent === '#5' && row.cells[1].textContent.startsWith('#5 Draft') && primary?.textContent === 'Draft'; })()`), true,
            'the second cell has one primary action, with ID before the title');

        console.log('Default order: open and active first (newest first), then done (newest first)');
        const byNewest = (a, b) => b.created_at.localeCompare(a.created_at);
        const want = [...open.slice().sort(byNewest), ...done.slice().sort(byNewest)].map(t => t.id);
        const got = await ids();
        assert.deepEqual(got, want, 'open work first, then done, each newest first');
        assert.deepEqual(got.slice(0, 5), [5, 4, 3, 2, 1], 'the first rows are the open tasks (' + got.slice(0, 5) + ')');
        assert.ok(got.slice(5).every(id => id >= 100), 'then only finished ones');
        console.log('  ok');

        console.log('The default order shows no sort arrow; a column\'s third click gives the default back and clears the arrow');
        assert.equal(await ev(`document.querySelector('#board-task-list .dt-sortbar-select').selectedOptions[0].textContent`), 'Open first, newest first');
        const arrows = () => ev(`[...document.querySelectorAll('#board-task-list th[aria-sort]')].filter(e => e.getAttribute('aria-sort') !== 'none').map(e => e.querySelector('.dt-sort').dataset.key + ':' + (e.getAttribute('aria-sort') === 'descending' ? '▼' : '▲'))`);
        assert.deepEqual(await arrows(), [], 'the default order has no arrow');
        const click = f => ev(`document.querySelector('#board-task-list .dt-sort[data-key="${f}"]').click(); true`);
        await click('created_at'); assert.deepEqual(await arrows(), ['created_at:▼'], 'first click: newest first, arrow down (the Created column)');
        assert.deepEqual(await ids(), [...open, ...done].sort(byNewest).map(t => t.id), 'a chosen Created is the plain date order');
        await click('created_at'); assert.deepEqual((await arrows())[0], 'created_at:▲', 'second click turns it round');
        await click('created_at');
        assert.deepEqual(await arrows(), [], 'third click: the arrow is gone');
        assert.deepEqual(await ids(), want, 'and the order is the default again: open first, then done');
        await click('priority'); assert.deepEqual(await arrows(), ['priority:▲'], 'Priority starts ascending');
        await click('assignee'); assert.deepEqual(await arrows(), ['assignee:▼'], 'another column starts its own count');
        await click('assignee'); await click('priority');
        assert.deepEqual(await arrows(), ['priority:▲'], 'a click on another column chooses it, it does not reset');
        await click('priority'); await click('priority');
        assert.deepEqual(await arrows(), [], 'three clicks on a column in a row, from any state, give the default back');
        assert.deepEqual(await ids(), want);
        console.log('  ok');

        console.log('A column the person chose sorts the whole list: Created is the plain date order, open and done mixed by date');
        await ev(`window.__coral._toggleTaskSort('created_at'); true`);
        const desc = await ids();
        assert.deepEqual(desc, [...open, ...done].sort(byNewest).map(t => t.id), 'Created descending, chosen, is the plain date order: finished tasks are among the open ones');
        assert.notDeepEqual(desc, want, 'the chosen order is not the default partition');
        await ev(`window.__coral._toggleTaskSort('created_at'); true`);
        const asc = await ids();
        assert.deepEqual(asc, [...open, ...done].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(t => t.id), 'turned round: the oldest first');
        await ev(`window.__coral._toggleTaskSort('id'); true`);
        assert.deepEqual((await ids()).slice(0, 3), [139, 138, 137], 'by id, newest column choice: the largest id first');
        console.log('  ok');

        console.log('Narrow dock: the Priority and Agent header labels do not touch, and neither is cut');
        // The dock is not shown on this page: the list goes into a visible host of the dock's width (its styles are by class).
        await ev(`(() => { const host = document.createElement('div'); host.id = 'qa-dock'; host.style.cssText = 'position:fixed;left:0;top:0;height:500px;z-index:99999;background:var(--bg-primary);display:flex;flex-direction:column'; host.appendChild(document.getElementById('board-task-list')); document.body.appendChild(host); return true; })()`);
        for (const w of (process.env.QA_WIDTHS || '300,330,360,420,520,680,770,790,900').split(',').map(Number)) {
            await ev(`document.getElementById('qa-dock').style.width = '${w}px'; true`);
            await ev(framesJs(2)); // the layout settles after the width changes
            const g = await ev(`(() => {
                const list = document.getElementById('board-task-list'), box = list.querySelector('.dt-box');
                const row = list.querySelector('tbody tr');
                const cells = [...row.cells].map(c => ({ key: c.dataset.key, left: c.getBoundingClientRect().left, shown: c.getBoundingClientRect().width > 0 }));
                const heads = [...list.querySelectorAll('thead th')].map(c => ({ key: c.querySelector('.dt-sort')?.dataset.key, left: c.getBoundingClientRect().left }));
                return { folded: box.classList.contains('dt-folded'), scroll: list.scrollWidth, width: list.clientWidth, cells, heads };
            })()`);
            assert.ok(g.scroll <= g.width + 1, `at ${w}px no sideways scroll: ${JSON.stringify(g)}`);
            for (const key of ['priority', 'assignee', 'type', 'cost', 'created_at']) {
                const cell = g.cells.find(c => c.key === key);
                if (g.folded && ['assignee', 'cost'].includes(key)) assert.equal(cell.shown, false, `empty ${key} is omitted at ${w}px`);
                else assert.ok(cell.shown, `${key} remains visible at ${w}px`);
                if (!g.folded) assert.ok(Math.abs(cell.left - g.heads.find(h => h.key === key).left) < 1, `${key} aligns with its header at ${w}px`);
            }
        }
        console.log('  ok');
        if (process.env.QA_WIDTHS) process.exitCode = 1; // measuring: print
        await ev(`document.getElementById('qa-dock').style.width = '360px'; window.__coral._toggleTaskSort('cost'); window.__coral._toggleTaskSort('cost'); window.__coral._toggleTaskSort('cost'); true`);
        await waitFor(`document.querySelector('#board-task-list .dt-box.dt-folded')`, 'folded sort controls');
        await ev(`(() => { const s = document.querySelector('#board-task-list .dt-sortbar-select'); s.focus(); s.value = 'priority'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        for (let i = 0; i < 2; i++) await ev(`(() => { const b = document.querySelector('#board-task-list .dt-sortbar-dir'); b.focus(); b.click(); })()`);
        assert.equal(await ev(`document.activeElement === document.querySelector('#board-task-list .dt-sortbar-select')`), true, 'resetting the sort returns focus to its visible selector');
        assert.equal(await ev(`document.querySelector('#board-task-list .dt-sortbar-select').selectedOptions[0].textContent`), 'Open first, newest first');
        await ev(`window.__heldTaskRow = document.querySelector('#board-task-list tbody tr'); T.tasks.renderBoardTaskList(); true`);
        assert.equal(await ev(`window.__heldTaskRow === document.querySelector('#board-task-list tbody tr')`), true, 'an unchanged refresh keeps row nodes');
        console.log('PASS task list order');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
