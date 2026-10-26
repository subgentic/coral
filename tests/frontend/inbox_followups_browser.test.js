// The Inbox's follow-ups (#7577, QA Reviewer 2's #7472 notes): focus starts at the heading of a group's table, of a task's page and of a saved message's page, and Back (and Escape, one level) puts it on the row it came from; the
// sidebar search's placeholder is "Search" (its name stays whole) so it is not cut at 200% text; the phone's Saved table stacks its rows (the message over its date, state and action: nothing behind a sideways scroll);
// Escape on a message's page is one level back, to the Saved table with the focus on that message's row. Drives Chrome over CDP with the tasks, the saved list and the waiting agents stubbed. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
const TASKS = [
    { id: 11, board_id: 'team-a', board_label: 'team-a', title: 'Review the release plan', priority: 'high', status: 'pending', created_by: 'Orchestrator', created_at: iso(7200000), updated_at: iso(3600000), revision: 1 },
    { id: 12, board_id: 'team-a', board_label: 'team-a', title: 'Write the release notes', priority: 'medium', status: 'in_progress', created_by: 'Orchestrator', created_at: iso(9000000), updated_at: iso(8000000), revision: 1 },
    { id: 13, board_id: 'team-b', board_label: 'team-b', title: 'Check the installer', priority: 'low', status: 'blocked', created_by: 'QA', created_at: iso(9500000), updated_at: iso(9400000), revision: 1 },
];
const SAVED = [
    { id: 1, kind: 'agent', ref: 'ag-one-session', key: '0000000000000000000a', title: 'Agent One', snippet: 'The release plan needs a rollback step.', agent_type: 'claude', saved_at: iso(600000), said_at: iso(900000), done_at: null },
    { id: 2, kind: 'agent', ref: 'ag-two-session', key: '0000000000000000000b', title: 'Agent Two', snippet: 'Ship on Tuesday, after QA.', agent_type: 'claude', saved_at: iso(1200000), said_at: iso(1500000), done_at: null },
    { id: 3, kind: 'agent', ref: 'ag-one-session', key: '0000000000000000000c', title: 'Agent One', snippet: 'An older note that is done.', agent_type: 'claude', saved_at: iso(86400000), said_at: iso(86500000), done_at: iso(80000000) },
];
const STUB = `(() => { const real = window.fetch; const J = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
    window.__saved = ${JSON.stringify(SAVED)}; window.__tasks = ${JSON.stringify(TASKS)}; window.__savedQs = [];
    window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.origin), p = url.pathname, m = (o && o.method) || 'GET';
        if (p === '/api/board/tasks' && m === 'GET') return J({ tasks: window.__tasks });
        const teamTasks = /^\\/api\\/board\\/([^/]+)\\/tasks$/.exec(p); if (teamTasks && m === 'GET') return J({ tasks: window.__tasks.filter(t => t.board_id === decodeURIComponent(teamTasks[1])), total_open: window.__tasks.filter(t => t.board_id === decodeURIComponent(teamTasks[1])).length });
        let t = /^\\/api\\/board\\/([^/]+)\\/tasks\\/(\\d+)$/.exec(p); if (t && m === 'GET') return J({ ...window.__tasks.find(x => x.id === Number(t[2])), assigned_to: 'Operator', body: 'Please check the plan and say what is missing.' });
        t = /^\\/api\\/saved\\/(\\d+)\\/message$/.exec(p); if (t) return J({ text: 'The whole message, in full: the plan needs a rollback step before Tuesday.', partial: false });
        t = /^\\/api\\/saved\\/(\\d+)$/.exec(p);
        if (t && m === 'PATCH') { const it = window.__saved.find(i => i.id === Number(t[1])); const body = JSON.parse(o.body); it.done_at = body.done ? new Date().toISOString() : null; return J({ ok: true }); }
        if (t && m === 'DELETE') { window.__saved = window.__saved.filter(i => i.id !== Number(t[1])); return J({ ok: true }); }
        if (p === '/api/saved' && m === 'GET') { window.__savedQs.push(url.search); const q = (url.searchParams.get('q') || '').toLowerCase(); const all = window.__saved;
            if (url.searchParams.get('limit') === '0') return J({ items: [], open: all.filter(i => !i.done_at).length, done: all.filter(i => i.done_at).length });
            const items = all.filter(i => !q || (i.snippet + ' ' + i.title).toLowerCase().includes(q));
            return J({ items, open: all.filter(i => !i.done_at).length, done: all.filter(i => i.done_at).length }); }
        return real(u, o); }; return true; })()`;
const AGENTS = (waiting) => waiting ? [
    { name: 'ag-one', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent One', working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_since: iso(300000), board_project: 'team-a', sleeping: false, goal: { id: 5, title: 'Ship 169', board: 'team-a' } },
    { name: 'ag-two', session_id: '00000002-0000-4000-8000-000000000002', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent Two', working_directory: '/repo/b', waiting_for_input: true, waiting_kind: 'permission', waiting_since: iso(120000), board_project: 'team-b', sleeping: false },
] : [];


(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const pane = '.sidebar-pane[data-pane="hub-inbox"]';
    const setAgents = waiting => ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(AGENTS(waiting))}; m.updateInboxTab(); return true; })()`);
    const active = () => ev(`(() => { const a = document.activeElement; return a ? { id: a.id || '', cls: typeof a.className === 'string' ? a.className : '', text: (a.textContent || '').trim().slice(0, 40), data: a.dataset ? { taskId: a.dataset.taskId || '', id: a.dataset.id || '', rowKey: a.dataset.rowKey || '' } : {} } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [label, w, h, mobile, font] of [['1280', 1280, 820, false, 16], ['1280 at 200% text', 1280, 820, false, 32], ['390', 390, 844, true, 16], ['390 at 200% text', 390, 844, true, 32]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings'); document.documentElement.style.fontSize = '${font}px'; true`);
            await setAgents(false);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!document.querySelector('${pane}').hidden && document.querySelectorAll('${pane} .view-list-item:is([data-key="needs"], [data-key="tasks"], [data-key="goals"], [data-key="saved"])').length === 4`, `${label}: the Inbox pane`, 10000);
            await waitFor(`document.querySelector('${pane} .view-list-item[data-key="tasks"] .view-list-count').textContent === '3'`, `${label}: the counts`, 10000);
            const step = async (name, fn) => { try { await fn(); console.log(`[PASS] ${label}: ${name}`); } catch (e) { console.log(`[FAIL] ${label}: ${name}: ${e.message}`); process.exitCode = 1; } };

            await step('the search says "Search" for every group and keeps its whole name', async () => {
                for (const [group, name] of [['needs', 'Search needs you'], ['tasks', 'Search tasks'], ['saved', 'Search saved messages']]) {
                    await ev(`document.querySelector('${pane} .view-list-item[data-key="${group}"]').click(); true`); await settle(300);
                    const r = await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); return { ph: i.placeholder, name: i.getAttribute('aria-label') }; })()`);
                    assert.deepEqual(r, { ph: 'Search', name }, group);
                }
            });
            if (!mobile) await step('opening a group by its header starts at its heading', async () => {
                await ev(`document.querySelector('${pane} .view-list-item[data-key="tasks"]').click(); true`); await settle(400);
                assert.equal((await active()).id, 'group-table-title');
            });
            const click = async (what, sel) => { const ok = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`); assert.ok(ok, `${what}: no ${sel}`); };
            const escape = () => ev(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
            if (!mobile) await step('a task page starts at its title and Back puts the focus on the task row', async () => {
                await ev(`window.switchNavTab('hub-inbox'); true`); await click('Tasks', `${pane} .view-list-item[data-key="tasks"]`); await settle(300);
                await click('the task', '#group-table-view .dt-primary[data-task-id="12"]');
                await waitFor(`!!document.querySelector('#inbox-page .ibx-reply-input')`, 'the task page', 8000); await settle(300);
                assert.equal((await active()).id, 'team-task-title', 'the title has the focus');
                await click('Back', '#inbox-page .goals-back'); await settle(400);
                const a = await active(); assert.equal(a.data.taskId, '12', 'Back: the row the task was opened from (' + JSON.stringify(a) + ')');
            });
            if (!mobile) await step('Escape on a task page is one level back, on the same row', async () => {
                await ev(`window.switchNavTab('hub-inbox'); true`); await click('Tasks', `${pane} .view-list-item[data-key="tasks"]`); await settle(300);
                await click('the task', '#group-table-view .dt-primary[data-task-id="13"]'); await settle(500);
                await escape(); await settle(500);
                const a = await active(); assert.equal(a.data.taskId, '13', 'Escape (' + JSON.stringify(a) + ')');
            });
            if (!mobile) await step('a saved message page starts at its title; Escape goes back to the Saved table with the focus on that message, not to another tab', async () => {
                await ev(`window.switchNavTab('hub-inbox'); true`); await click('Saved', `${pane} .view-list-item[data-key="saved"]`); await settle(400);
                const id = await ev(`document.querySelectorAll('#group-table-view .dt-primary')[1].dataset.id`);
                await click('the message', `#group-table-view .dt-primary[data-id="${id}"]`); await settle(500);
                assert.equal((await active()).cls.includes('wf-item-title'), true, 'a message page starts at its title');
                await escape(); await settle(500);
                assert.equal(await ev(`document.querySelector('#group-table-title').textContent`), 'Saved', 'back at the Saved table');
                const a = await active(); assert.equal(a.data.id, id, 'with the focus on that message (' + JSON.stringify(a) + ')');
                assert.equal(await ev(`document.body.getAttribute('data-nav-tab')`), 'hub-inbox', 'still in the Inbox');
            });
            if (mobile) await step('the phone: a task opens at its title and Back puts the focus on its row in the table', async () => {
                await ev(`document.querySelector('${pane} .view-list-item[data-key="tasks"]').click(); true`); await settle(400);
                await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`); await settle(600);
                assert.equal((await active()).id, 'team-task-title', 'the title has the focus');
                await ev(`document.querySelector('#inbox-page .goals-back').click(); true`); await settle(500);
                const a = await active(); assert.ok(a.cls.includes('dt-primary') && a.data.taskId, 'the task row in the table has the focus (' + JSON.stringify(a) + ')');
            });
            if (mobile) await step('the Saved table stacks: the message has the row, its state and action are under it, nothing is behind a sideways scroll', async () => {
                await ev(`window.switchNavTab('hub-inbox'); document.querySelector('${pane} .view-list-item[data-key="saved"]').click(); true`); await settle(500);
                const r = await ev(`(() => { const tb = document.querySelector('#group-table-view .dt-table'); const row = tb.querySelector('tbody tr'); const tds = [...row.children]; const rb = row.getBoundingClientRect(); const first = tds[0].getBoundingClientRect(); const rest = tds.filter(t => t.classList.contains('dt-line-2')).map(t => t.getBoundingClientRect()); const sc = document.querySelector('#group-table-view .dt-box'); const act = row.querySelector('button.dt-quiet'); const ab = act && act.getBoundingClientRect();
                    return { firstW: Math.round(first.width), rowW: Math.round(rb.width), under: rest.every(b => b.top >= first.bottom - 1), over: sc.scrollWidth - sc.clientWidth, actionIn: !!ab && ab.left >= -1 && ab.right <= innerWidth + 1, role: tb.getAttribute('role'), cells: tds.map(t => t.getAttribute('role')) }; })()`);
                assert.ok(r.firstW >= r.rowW * 0.45, 'the message takes the first line (its date at the right): ' + JSON.stringify(r)); assert.ok(r.under, 'its state and action are under it: ' + JSON.stringify(r)); assert.ok(r.over <= 1, 'no sideways scroll: ' + JSON.stringify(r));
                assert.ok(r.actionIn, 'the action is on screen: ' + JSON.stringify(r)); assert.equal(r.role, 'table'); assert.ok(r.cells.every(c => c === 'cell'), 'cells keep their role');
            });
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
