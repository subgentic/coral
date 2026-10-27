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
    { id: 3, title: 'In review', status: 'review_pending', priority: 'medium', assigned_to: 'Dev', reviewers: ['QA', 'UX', 'Sec'], created_at: '2026-09-03T10:00:00Z' },
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
        const ids = () => ev(`[...document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)')].map(r => Number(r.dataset.taskId))`);
        await waitFor(`document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length === 45`, 'the 45 rows');

        console.log('Columns put Status and the primary Task before the facts');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#board-task-list thead th')].map(h => h.querySelector('.dt-sort > span, .dt-head-text').textContent.trim())`),
            ['State', 'Task', 'Who']); // the dock is the Tasks view's agent-team scope: State, Task and Who (#7962, #8060)
        assert.deepEqual(await ev(`[...document.querySelector('#board-task-list tbody tr').cells].map(c => c.dataset.key)`),
            ['state', 'task', 'who']);
        assert.equal(await ev(`(() => { const row = document.querySelector('#board-task-list tbody tr'); const primary = row.cells[1].querySelector('.dt-primary'); return row.querySelectorAll('.dt-primary').length === 1 && row.dataset.taskId === '5' && !row.querySelector('.dt-id') && primary?.textContent === 'Draft'; })()`), true,
            'the second cell has one primary action, with the ID retained in row data and omitted visually');

        console.log('Who is circles, as on the Tasks tab (#8507): the person solid, the reviewers outlined (two, then +N), the whole named and shown on hover, no name beside them');
        const who = await ev(`(() => { const row = [...document.querySelectorAll('#board-task-list tbody tr')].find(r => r.dataset.taskId === '3'); const c = row.querySelector('td[data-key="who"]'), i = c.querySelector('[role=img]'); return { label: i && i.getAttribute('aria-label'), title: i && i.title, solid: c.querySelectorAll('.dt-avatar:not(.dt-avatar-review)').length, outlined: c.querySelectorAll('.dt-avatar-review').length, more: (c.querySelector('.dt-avatars-more') || {}).textContent, words: !!c.querySelector('.dt-person-name, .board-task-assignee'), w: Math.round(c.getBoundingClientRect().width) }; })()`);
        assert.deepEqual({ ...who, w: undefined }, { label: 'Dev, review by QA, UX, Sec', title: 'Dev, review by QA, UX, Sec', solid: 1, outlined: 2, more: '+1', words: false, w: undefined }, JSON.stringify(who));
        assert.ok(who.w <= 110, `the column is as narrow as its circles (${who.w} px)`);
        console.log('  ok');

        console.log('Default order: open and active first (newest first), then done (newest first)');
        const byNewest = (a, b) => b.created_at.localeCompare(a.created_at);
        const want = [...open.slice().sort(byNewest), ...done.slice().sort(byNewest)].map(t => t.id);
        const got = await ids();
        assert.deepEqual(got, want, 'open work first, then done, each newest first');
        assert.deepEqual(got.slice(0, 5), [5, 4, 3, 2, 1], 'the first rows are the open tasks (' + got.slice(0, 5) + ')');
        assert.ok(got.slice(5).every(id => id >= 100), 'then only finished ones');
        console.log('  ok');

        console.log('The default order shows no sort arrow; a column\'s third click gives the default back and clears the arrow');
        const arrows = () => ev(`[...document.querySelectorAll('#board-task-list th[aria-sort]')].filter(e => e.getAttribute('aria-sort') !== 'none').map(e => e.querySelector('.dt-sort').dataset.key + ':' + (e.getAttribute('aria-sort') === 'descending' ? '▼' : '▲'))`);
        assert.deepEqual(await arrows(), [], 'the default order has no arrow');
        const click = f => ev(`document.querySelector('#board-task-list .dt-sort[data-key="${f}"]').click(); true`);
        await click('task'); assert.deepEqual(await arrows(), ['task:▼'], 'first click: the largest id first, arrow down (the Task column)');
        assert.deepEqual((await ids()).slice(0, 3), [139, 138, 137], 'a chosen Task column is the plain id order');
        await click('task'); assert.deepEqual((await arrows())[0], 'task:▲', 'second click turns it round');
        await click('task');
        assert.deepEqual(await arrows(), [], 'third click: the arrow is gone');
        assert.deepEqual(await ids(), want, 'and the order is the default again: open first, then done');
        await click('who'); assert.deepEqual(await arrows(), ['who:▼'], 'another column starts its own count');
        await click('task'); assert.deepEqual(await arrows(), ['task:▼'], 'a click on another column chooses it, it does not reset');
        await click('task'); await click('task');
        assert.deepEqual(await arrows(), [], 'three clicks on a column in a row, from any state, give the default back');
        assert.deepEqual(await ids(), want);
        console.log('  ok');

        console.log('A column the person chose sorts the whole list: Task is the plain id order, open and done mixed');
        await ev(`window.__coral._toggleTaskSort('id'); true`);
        assert.deepEqual((await ids()).slice(0, 3), [139, 138, 137], 'by id, the largest first: finished tasks are among the open ones');
        assert.notDeepEqual(await ids(), want, 'the chosen order is not the default partition');
        await ev(`window.__coral._toggleTaskSort('id'); true`);
        assert.deepEqual((await ids()).slice(0, 3), [1, 2, 3], 'turned round: the smallest id first');
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
            for (const key of ['who']) {
                const cell = g.cells.find(c => c.key === key);
                if (g.folded && ['who'].includes(key)) assert.equal(cell.shown, false, `empty ${key} is omitted at ${w}px`);
                else assert.ok(cell.shown, `${key} remains visible at ${w}px`);
                if (!g.folded) assert.ok(Math.abs(cell.left - g.heads.find(h => h.key === key).left) < 1, `${key} aligns with its header at ${w}px`);
            }
        }
        console.log('  ok');
        if (process.env.QA_WIDTHS) process.exitCode = 1; // measuring: print
        await ev(`document.getElementById('qa-dock').style.width = '360px'; true`);
        await waitFor(`document.querySelector('#board-task-list .dt-box.dt-fold-none')`, 'one-line dock');
        // one sort, inside Filters only (#7924): a folded dock has no "Sort by" row of its own
        assert.equal(await ev(`[...document.querySelectorAll('#board-task-list .dt-sortbar')].every(e => e.hidden || !e.getClientRects().length)`), true, 'no Sort by row in the dock: the Filters panel has the sort');
        assert.equal(await ev(`!!document.querySelector('#board-task-bar #tk-sort')`), true, 'the Filters panel holds it');
        await ev(`window.__heldTaskRow = document.querySelector('#board-task-list tbody tr'); T.tasks.renderBoardTaskList(); true`);
        assert.equal(await ev(`window.__heldTaskRow === document.querySelector('#board-task-list tbody tr')`), true, 'an unchanged refresh keeps row nodes');
        console.log('PASS task list order');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
