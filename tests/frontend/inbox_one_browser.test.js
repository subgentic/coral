// The dashboard's own Inbox on the shared sidebar (#7472, part 2 of one sidebar, UI/UX's audit c2596330 and its answers on the board): three groups (Needs you, Tasks, Saved) with counts, Needs you and Tasks listing
// their rows and Saved its header; one search box that names the group on screen and searches it, Display options (Saved's Filters and Sort) for Saved only; a group's name opens a table at 20/700 with its count
// (Needs you: Item, Team, When, and Folder, Asks and Goal columns when a row has one; Tasks: the one task row, State, Task, Priority, Team, Updated; Saved: Message, Saved, State, Action, with Open and Done as chips with counts and one Done or Reopen
// button per row); a task's page mounts the shared component for the one task (its text and reply box, no second heading) under a "← Tasks" link and a 17/700 title; a saved message's page has its own link
// back, a bar pinned at the foot (More with Remove, Open as the primary; the whole message is in the page, #7660); one empty line per group; both themes and 200% text; a phone's list is the page and an item the screen after
// it. Drives Chrome over CDP through agent_view_harness.js with the tasks, the saved list and the waiting agents stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, auditRegion } = require('./helpers/contrast');
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
        if (/^\\/api\\/board\\/team-a\\/messages\\/all$/.test(p) && m === 'GET') return J([{ id: 1, subscriber_id: 'Operator', content: '@Orchestrator: Is the plan final?', created_at: new Date(Date.now() - 1800000).toISOString(), task_id: 11 }, { id: 2, subscriber_id: 'Orchestrator', content: 'Yes: **shipping Tuesday**, after the rollback step.', created_at: new Date(Date.now() - 900000).toISOString(), task_id: 11 }]);
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
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const pane = '.sidebar-pane[data-pane="hub-inbox"]';
    const attn = `${pane} .view-list-item:is([data-key="needs"], [data-key="tasks"], [data-key="goals"], [data-key="saved"])`; // the Needs attention folders; the chat folders under them have their own suite (mailbox_chats)
    const ON_SCALE = `(root, sizes) => { const want = getComputedStyle(document.body).fontFamily, out = [];
        for (const e of root.querySelectorAll('*')) { if (!e.getClientRects().length || e.matches('.material-icons, .sr-only, pre, code, svg, svg *') || e.closest('pre, code')) continue;
            if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
            const c = getComputedStyle(e), px = parseFloat(c.fontSize); const label = e.tagName + '.' + e.className + ' "' + e.textContent.trim().slice(0, 24) + '" ' + c.fontSize + '/' + c.fontWeight;
            if (c.fontFamily !== want) out.push('family ' + label); else if (!sizes.includes(px)) out.push('size ' + label); else if (!['400', '500', '600', '700'].includes(c.fontWeight)) out.push('weight ' + label); }
        return out; }`;
    const SCALE = '[11, 12, 13, 14, 17, 20]';
    const setAgents = waiting => ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(AGENTS(waiting))}; m.updateInboxTab(); return true; })()`);
    const tableTitle = () => ev(`(document.querySelector('#group-table-title') || {}).textContent`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [1024, 768, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await setAgents(true);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!document.querySelector('${pane}').hidden && document.querySelectorAll('${attn}').length === 4`, at + 'the Inbox pane', 10000);
            await waitFor(`document.querySelector('${pane} .view-list-item[data-key="tasks"] .view-list-count').textContent === '3' && document.querySelector('${pane} .view-list-item[data-key="saved"] .view-list-count').textContent === '2'`, at + 'the counts', 10000);

            assert.deepEqual(await ev(`[...document.querySelectorAll('${attn} .view-list-name')].map(e => e.textContent)`), ['Needs you', 'Tasks', 'Goals', 'Saved'], at + 'the folders (#7785)');
            assert.deepEqual(await ev(`[...document.querySelectorAll('${attn} .view-list-count')].map(e => e.textContent)`), ['2', '3', '0', '2'], at + 'with their counts (Goals has its own now: none open in this world)');
            assert.equal(await ev(`document.querySelectorAll('${pane} li.sb-row, ${pane} .sgroup-header').length`), 0, at + 'the pane lists folders only: the rows are the table\'s');
            if (!mobile) assert.equal(await ev(`Math.round(document.querySelector('${pane} .view-list-item').getBoundingClientRect().height) >= 36`), true, at + 'a folder is at least 36 px high');
            if (!mobile) assert.deepEqual(await ev(`(() => { const t = document.querySelector('${pane} .view-list-title'), n = document.querySelector('${pane} .view-list-item .view-list-name'); const left = e => { const r = document.createRange(); r.selectNodeContents(e); return Math.round(r.getBoundingClientRect().left); }; return [left(t), left(n)]; })()`).then(([t, n]) => Math.abs(t - n) <= 1), true, at + 'the section title starts where the folders\' text does (#7851)');
            if (!mobile) assert.equal(await ev(`(() => { const probe = document.createElement('i'); probe.style.color = 'var(--text-muted)'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(document.querySelector('${pane} .view-list-title')).color === want; })()`), true, at + 'the section title is the scheme\'s tertiary, --text-muted (#7883)');

            assert.equal(await ev(`document.querySelector('${pane} .sidebar-search-input').getAttribute('aria-label')`), 'Search needs you', at + 'the search is named for the group on screen');
            assert.equal(await ev(`document.querySelector('${pane} [data-display-button]').hidden`), true, at + 'Display options is for Saved only');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            assert.equal(await ev(`document.getElementById('inbox-title') === null && document.getElementById('inbox-tablist') === null`), true, at + 'the old title and tab strip are gone');

            if (mobile) {
                await waitFor(`!!document.querySelector('#group-table-view .view-list-select') && document.getElementById('group-table-view').getClientRects().length > 0`, at + 'the phone opens on the table with the folders\' select on top', 10000);
                assert.equal(await ev(`[...document.querySelectorAll('#mobile-inbox-list .sidebar-hide-btn')].some(b => b.getClientRects().length > 0)`), false, at + 'no Hide on a phone');
                assert.equal(await ev(`(() => { const sel = document.querySelector('#group-table-view .view-list-select').getBoundingClientRect(), nxt = document.querySelector('#group-table-view .gt-toolbar, #group-table-view .group-table-head').getBoundingClientRect(); return nxt.top - sel.bottom >= 8; })()`), true, at + 'the folders\' select does not touch the field under it: 8 px (#7851)');
                await shot(`inbox-one-list-${w}`);
                await ev(`(() => { const s = document.querySelector('#group-table-view .view-list-select'); s.value = 'tasks'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`!!document.querySelector('#group-table-view .dt-primary')`, at + 'the select opens Tasks', 8000);
                await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
                await waitFor(`document.getElementById('inbox-page').getClientRects().length > 0 && !!document.querySelector('#inbox-page .ibx-reply-input')`, at + 'the task as a screen of its own', 10000);
                assert.equal(await ev(`document.querySelector('#inbox-page .goals-back').textContent.trim()`), '\u2190 Tasks', at + 'with the way back, to the folder it came from');
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, at + 'no sideways scroll on a task');
                await shot(`inbox-one-task-${w}`);
                await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
                await waitFor(`document.getElementById('group-table-view').getClientRects().length > 0 && document.getElementById('inbox-page').hidden`, at + 'back is the Tasks table', 4000);
                continue;
            }

            // the tab opens on the group last on screen: Needs you, as a table
            await waitFor(`!!document.querySelector('#group-table-view table.dt-table') && document.getElementById('group-table-view').checkVisibility()`, at + 'the first group as a table', 10000);
            assert.equal(await tableTitle(), 'Needs you', at + 'Needs you first');
            const needsBar = await ev(`(() => { const b = document.querySelector('#group-table-view .gt-toolbar'), s = b && b.querySelector('.gt-search, .list-bar-search'); return s ? { w: Math.round(s.getBoundingClientRect().width), left: Math.round(s.getBoundingClientRect().left), action: !!b.querySelector('.team-tb-action'), chips: b.querySelectorAll('.group-chip').length } : null; })()`);
            assert.ok(needsBar && needsBar.chips === 0 && !needsBar.action, at + 'the page has the toolbar line: the search field, no chips and no create action on Needs you (#7723): ' + JSON.stringify(needsBar));
            // the title and its count are the first thing of the toolbar's one row, not a row of their own (#8700; inbox_header_browser measures the line)
            assert.equal(await ev(`(() => { const row = document.querySelector('#group-table-view .inbox-folder-toolbar .list-bar-search-row'); return !!row && row.firstElementChild.classList.contains('inbox-folder-head') && row.firstElementChild.querySelector('#group-table-title') !== null && !document.querySelector('#group-table-view .group-table-head'); })()`), true, at + 'the title is in the toolbar row, with no row of its own');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => [h.textContent.replace(/[↑↓↕]/g, '').trim(), h.getAttribute('scope')])`), [['Agent', 'col'], ['CLI', 'col'], ['Folder', 'col'], ['Team', 'col'], ['Goal', 'col'], ['Waiting', 'col']], at + 'Agent, CLI, Folder (the rows have one), Team, Goal because a row has one, and how long it Waits; no Waiting for column when no row has a question');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.querySelector('.dt-primary').textContent.trim() + '|' + r.querySelector('td[data-key="team"]').textContent.trim())`), ['Agent One|team-a', 'Agent Two|team-b'], at + 'a row per waiting agent, with its team');
            assert.equal(await ev(`document.querySelector('#group-table-view tbody tr .dt-link').textContent`), 'Ship 169', at + "the goal's cell opens the goal");
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#group-table-title')), c = getComputedStyle(document.querySelector('#group-table-view .inbox-folder-head .session-group-count')); return [t.fontSize, t.fontWeight, c.fontSize, c.fontWeight]; })()`), ['20px', '700', '11px', '600'], at + 'the title is 20/700, its count 11/600');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the table is on the scale');
            await shot(`inbox-one-needs-${w}`);

            // the search names its group and narrows it
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = 'two'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'the search narrows Needs you', 5000);
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'cleared', 5000);

            // Tasks
            await ev(`window.switchNavTab('hub-inbox'); document.querySelector('${pane} .view-list-item[data-key="tasks"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Tasks'`, at + 'Tasks opens its table', 8000);
            assert.equal(await ev(`document.querySelector('${pane} .sidebar-search-input').getAttribute('aria-label')`), 'Search tasks', at + 'the search is named for Tasks now');
            // the one task row (#7737): a table on a desktop (State, Task, Priority, Team, Updated), the two-line column on a phone; one word set for the state (the Inbox's "Open" is Queued)
            const wide = await ev(`!document.querySelector('#group-table-view .dt-box').classList.contains('dt-folded')`);
            if (wide) assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => h.textContent.replace(/[↑↓↕]/g, '').trim()).filter(Boolean)`), ['State', 'Task', 'Priority', 'Team', 'Updated'], at + 'State, Task, Priority, Team, Updated');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr')].map(r => [r.querySelector('.dt-primary').textContent, getComputedStyle(r.querySelector('td[data-key="priority"]')).display === 'none' ? '' : r.querySelector('td[data-key="priority"]').textContent, r.querySelector('.goal-chip').textContent, getComputedStyle(r.querySelector('td[data-key="team"]')).display === 'none' ? '' : r.querySelector('td[data-key="team"]').textContent].join('|'))`),
                wide ? ['Review the release plan|High|Queued|team-a', 'Write the release notes|Medium|In progress|team-a', 'Check the installer|Low|Blocked|team-b'] : ['Review the release plan|High|Queued|', 'Write the release notes||In progress|', 'Check the installer||Blocked|'], at + 'rows by priority, in words');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the tasks table is on the scale');
            await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-page .ibx-reply-input') && document.getElementById('inbox-page').checkVisibility()`, at + "the Inbox task page", 10000);
            assert.equal(await ev(`location.pathname`), '/inbox/tasks/team-a/11', at + 'one task URL');
            assert.equal(await ev(`document.querySelector('#inbox-page .goals-back').textContent.trim()`), '← Tasks', at + 'back names the Tasks folder');
            assert.equal(await ev(`document.querySelector('#team-task-title').textContent`), '#11 Review the release plan', at + 'one title');
            assert.match(await ev(`document.querySelector('#inbox-page .team-task-body').textContent`), /Please check the plan/, at + 'the task description');
            assert.equal(await ev(`[...document.querySelectorAll('#inbox-page .ibx-task-title')].filter(e => e.getClientRects().length).length`), 0, at + 'no second title');
            assert.equal(await ev(`document.querySelectorAll('#inbox-page .ibx-reply-input').length`), 1, at + 'one reply box');
            await shot(`inbox-one-task-${w}`);
            await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && location.pathname === '/inbox/tasks'`, at + 'back is the Inbox Tasks table', 8000);
            await ev(`window.switchNavTab('hub-inbox'); true`);

            // Saved
            await ev(`document.querySelector('${pane} .view-list-item[data-key="saved"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Saved' && document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'Saved opens its table', 10000);
            assert.equal(await ev(`document.querySelector('${pane} .sidebar-search-input').getAttribute('aria-label')`), 'Search saved messages', at + 'the search says it is for saved messages');
            assert.equal(await ev(`document.querySelector('${pane} [data-display-button]').hidden`), false, at + 'Display options is there for Saved');
            const savedBar = await ev(`(() => { const b = document.querySelector('#group-table-view .gt-toolbar'), s = b.querySelector('.gt-search, input[type=search]'); return { w: Math.round(s.getBoundingClientRect().width), left: Math.round(s.getBoundingClientRect().left), chipsOnLine: b.querySelectorAll('.group-chip, .team-tb-pills .goals-chip').length, chipsInHead: document.querySelectorAll('#group-table-view .group-table-head ~ .group-table-chips, #group-table-view .group-table-head .group-chip').length, label: s.getAttribute('aria-label') }; })()`);
            assert.ok(Math.abs(savedBar.left - needsBar.left) <= 16, at + `the search box does not jump between groups: about the same place on Needs you and Saved (QA finding 2; Saved has the shared toolbar since #8602, as Tasks has, so its edge is the toolbar's): ${savedBar.left} vs ${needsBar.left}`);
            assert.deepEqual([savedBar.chipsOnLine, savedBar.chipsInHead, savedBar.label], [2, 0, 'Search saved messages'], at + 'Saved\'s Open and Done chips are on the toolbar line, not a row under the title (QA finding 3), and the page\'s field says what it searches');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => h.textContent)`), ['Message', 'Saved', 'State', 'Action'], at + 'Message, Saved, State, Action');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim() + (c.getAttribute('aria-pressed') === 'true' ? '*' : ''))`), ['Open 2*', 'Done 1'], at + 'Open and Done chips with counts');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody .dt-quiet')].map(b => b.textContent)`), ['Done', 'Done'], at + 'one quiet Done button per row');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the saved table is on the scale');
            await shot(`inbox-one-saved-${w}`);
            // Display options hold Filters and Sort, and no second search box
            await ev(`document.querySelector('${pane} [data-display-button]').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-saved-bar .list-bar-select, #inbox-saved-bar select')`, at + 'Filters and Sort in Display options', 5000);
            assert.equal(await ev(`document.querySelector('#inbox-saved-bar .list-bar-search') === null`), true, at + 'and no second search box');
            await ev(`document.querySelector('${pane} [data-display-button]').click(); true`);
            // Done moves a row to the Done chip, and Reopen brings it back
            await ev(`document.querySelector('#group-table-view tbody .dt-quiet').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'Done moves the row out of Open', 8000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`), ['Open 1', 'Done 2'], at + 'the counts follow');
            assert.equal(await ev(`document.getElementById('inbox-live').textContent`), 'Marked done', at + 'a polite line says so');
            await ev(`document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')[1].click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2 && document.querySelector('#group-table-view tbody .dt-quiet').textContent === 'Reopen'`, at + 'the Done chip lists them, with Reopen', 8000);
            await ev(`document.querySelector('#group-table-view tbody .dt-quiet').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'Reopen takes it out of Done', 8000);
            await ev(`document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')[0].click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'back on Open with both', 8000);
            // the search is the server's, and the table says so
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = 'rollback'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1 && /every saved message/.test(document.querySelector('#group-table-view .group-table-note').textContent)`, at + 'the search narrows Saved and says it covers all', 8000);
            assert.ok((await ev(`window.__savedQs`)).some(q => /q=rollback/.test(q)), at + 'the server did the matching');
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'cleared', 8000);

            // the group on screen is kept in this browser, and a newly waiting agent is still announced while Saved is shown
            assert.equal(await ev(`localStorage.getItem('coral.inbox.tab')`), 'saved', at + 'the group last on screen is remembered');
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js');
                state.liveSessions = [...state.liveSessions, { ...state.liveSessions[0], name: 'ag-three', session_id: '00000003-0000-4000-8000-000000000003', display_name: 'Agent Three' }]; m.updateInboxTab(); return true; })()`);
            await waitFor(`/Agent Three needs you/.test(document.getElementById('inbox-live').textContent)`, at + 'the announcement while Saved is shown', 5000);
            await setAgents(true);
            // a saved message's page: its link back, the message, and a bar with the primary last
            await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-page .item-bar') && document.getElementById('inbox-page').checkVisibility()`, at + "the saved message's page", 8000);
            assert.equal(await ev(`document.querySelector('#inbox-page > .group-back').textContent`), '← Saved', at + 'back names Saved');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#inbox-page .wf-item-title')); return [t.fontSize, t.fontWeight]; })()`), ['17px', '700'], at + 'the title is 17/700');
            assert.match(await ev(`document.querySelector('#inbox-page .inbox-saved-snippet').textContent`), /rollback step|Tuesday/, at + 'the message is on the page');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#inbox-page .item-bar > .btn, #inbox-page .item-bar > .wf-more > .btn')].filter(b => b.getClientRects().length).map(b => b.textContent.trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['More', 'Open in Chats*'], at + 'the bar: More, Open, the primary last (no Read the whole message: the text is on the page)');
            assert.equal(await ev(`(() => { const r = document.querySelector('#inbox-page .item-bar').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.bottom >= innerHeight - 40; })()`), true, at + 'the bar is at the foot of the screen');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('inbox-page'), ${SCALE})`), [], at + "every text of the message's page is on the scale");
            await waitFor(`/whole message, in full/.test(document.querySelector('#inbox-page .ibx-saved-body').textContent)`, at + 'the whole message is shown at once', 8000);
            assert.equal(await ev(`!!document.querySelector('#inbox-page .ibx-saved-toggle')`), false, at + 'there is no Read the whole message button');
            await shot(`inbox-one-message-${w}`);
            // Remove is behind More
            assert.equal(await ev(`[...document.querySelectorAll('#inbox-page .wf-more-menu button')].some(b => b.getClientRects().length > 0)`), false, at + 'Remove is not on the page until More opens');
            await ev(`document.querySelector('#inbox-page .wf-more > .btn').click(); true`);
            await ev(`[...document.querySelectorAll('#inbox-page .wf-more-menu button')].find(b => /Remove/.test(b.textContent)).click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'Remove takes it from the list and returns to the table', 8000);
            assert.equal(await ev(`document.querySelector('${pane} .view-list-item[data-key="saved"] .view-list-count').textContent`), '1', at + "and the folder's count");

            // nothing waiting: one empty line
            await setAgents(false);
            await ev(`document.querySelector('${pane} .view-list-item[data-key="needs"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Needs you' && !!document.querySelector('#group-table-view .empty-line')`, at + 'the empty Needs you', 8000);
            assert.deepEqual(await ev(`(() => { const l = document.querySelector('#group-table-view .empty-line'), c = getComputedStyle(l); return [l.textContent, c.fontSize, c.fontWeight]; })()`), ['Nothing needs your input.', '14px', '400'], at + 'one empty line, 14/400');
            await shot(`inbox-one-empty-${w}`);
            await setAgents(true);

            // both themes and 200% text
            if (w === 1280) for (const theme of ['dark', 'light']) for (const zoom of ['', '32px']) {
                const how = at + `${theme}${zoom ? ', 200% text' : ''}: `;
                await setTheme(ev, theme); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await ev(`window.switchNavTab('hub-inbox'); document.querySelector('${pane} .view-list-item[data-key="tasks"]').click(); true`);
                await waitFor(`document.querySelector('#group-table-title').textContent === 'Tasks'`, how + 'the tasks table', 8000);
                const au = await auditRegion(ev, ['.sidebar', '#group-table-view']);
                assert.deepEqual(au.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + 'the sidebar and the table: contrast');
                await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
                await waitFor(`!!document.querySelector('#inbox-page .ibx-reply-input')`, how + 'a task', 8000);
                const au2 = await auditRegion(ev, ['#inbox-page']);
                assert.deepEqual(au2.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + "a task's page: contrast");
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, how + 'no sideways scroll');
            }
            await setTheme(ev, 'dark'); await ev(`document.documentElement.style.fontSize = ''; true`);
        }
        console.log('PASS inbox one sidebar: groups, tables, a task\'s page and a saved message\'s page, search, Display options, empty line, phone screens');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
