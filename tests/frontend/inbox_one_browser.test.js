// The dashboard's own Inbox on the shared sidebar (#7472, part 2 of one sidebar, UI/UX's audit c2596330 and its answers on the board): three groups (Needs you, Tasks, Saved) with counts, Needs you and Tasks listing
// their rows and Saved its header; one search box that names the group on screen and searches it, Display options (Saved's Filters and Sort) for Saved only; a group's name opens a table at 20/700 with its count
// (Needs you: Item, Team, When, and Folder, Asks and Goal columns when a row has one; Tasks: Task, Priority, State, Team; Saved: Message, Saved, State, Action, with Open and Done as chips with counts and one Done or Reopen
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
        let t = /^\\/api\\/board\\/([^/]+)\\/tasks\\/(\\d+)$/.exec(p); if (t && m === 'GET') return J({ body: 'Please check the plan and say what is missing.', created_by: 'Orchestrator', status: 'pending' });
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
            await waitFor(`!document.querySelector('${pane}').hidden && document.querySelectorAll('${pane} .sgroup-header').length === 3`, at + 'the Inbox pane', 10000);
            await waitFor(`document.querySelectorAll('${pane} .sgroup-header .session-group-count')[1].textContent === '3' && document.querySelectorAll('${pane} .sgroup-header .session-group-count')[2].textContent === '2'`, at + 'the counts', 10000);

            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane} .sgroup-header .group-name-text')].map(e => e.textContent)`), ['Needs you', 'Tasks', 'Saved'], at + 'the three groups');
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane} .sgroup-header .session-group-count')].map(e => e.textContent)`), ['2', '3', '2'], at + 'with their counts');
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane} .sgroup-header')].map(h => !!h.querySelector('button.group-chevron'))`), [true, true, true], at + 'every group has a chevron, and Saved lists its messages under it like the others');
            assert.equal(await ev(`document.querySelectorAll('${pane} li.sb-row').length`), 7, at + 'the three groups list their rows (2, 3 and the 2 saved messages)');
            // the button is the row: the li around it has no padding and the button is 36 px high (44 on a phone), UI/UX's rule for every sidebar list (#7473)
            assert.deepEqual(await ev(`(() => { const b = document.querySelector('${pane} li:not(.session-group-header) > .row-btn'), li = b.parentElement, cs = getComputedStyle(li); return { pad: [cs.paddingTop, cs.paddingBottom], h: Math.round(b.getBoundingClientRect().height) >= ${mobile ? 44 : 36}, same: Math.abs(li.getBoundingClientRect().height - b.getBoundingClientRect().height) <= 1 }; })()`), { pad: ['0px', '0px'], h: true, same: true }, at + 'a row is its button, no padding on the li, at least ${mobile ? 44 : 36} px high');

            assert.equal(await ev(`document.querySelector('${pane} .sidebar-search-input').getAttribute('aria-label')`), 'Search needs you', at + 'the search is named for the group on screen');
            assert.equal(await ev(`document.querySelector('${pane} [data-display-button]').hidden`), true, at + 'Display options is for Saved only');
            if (mobile) assert.equal(await ev(`Math.round(document.querySelector('${pane}').getBoundingClientRect().width) >= innerWidth - 1`), true, at + 'the phone list is the width of the screen');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            assert.equal(await ev(`document.getElementById('inbox-title') === null && document.getElementById('inbox-tablist') === null`), true, at + 'the old title and tab strip are gone');

            if (mobile) {
                assert.equal(await ev(`!!document.querySelector('#mobile-inbox-list ${pane}')`), true, at + 'the pane is in the phone page');
                assert.equal(await ev(`[...document.querySelectorAll('#mobile-inbox-list .sidebar-hide-btn')].some(b => b.getClientRects().length > 0)`), false, at + 'no Hide on a phone');
                assert.equal(await ev(`document.getElementById('inbox-local').getClientRects().length`), 0, at + 'the centre is not shown until an item is chosen');
                await shot(`inbox-one-list-${w}`);
                await ev(`document.querySelector('${pane} .row-btn[data-on-click="inbox-task-open"]').click(); true`);
                await waitFor(`document.getElementById('inbox-page').getClientRects().length > 0 && !!document.querySelector('#inbox-page .ibx-reply-input')`, at + 'the task as a screen of its own', 10000);
                assert.equal(await ev(`document.getElementById('mobile-inbox-list').getClientRects().length`), 0, at + 'and the list is not under it');
                assert.equal(await ev(`document.querySelector('#inbox-page .inbox-phone-back').textContent.trim()`), '\u2190 Inbox', at + 'with the way back');
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, at + 'no sideways scroll on a task');
                await shot(`inbox-one-task-${w}`);
                await ev(`document.querySelector('#inbox-page .inbox-phone-back').click(); true`);
                await waitFor(`document.getElementById('mobile-inbox-list').getClientRects().length > 0 && document.getElementById('inbox-local').getClientRects().length === 0`, at + 'back is the list', 4000);
                continue;
            }

            // the tab opens on the group last on screen: Needs you, as a table
            await waitFor(`!!document.querySelector('#group-table-view table.group-table') && document.getElementById('group-table-view').checkVisibility()`, at + 'the first group as a table', 10000);
            assert.equal(await tableTitle(), 'Needs you', at + 'Needs you first');
            assert.equal(await ev(`(() => { const v = document.getElementById('group-table-view'), t = document.querySelector('#group-table-title').getBoundingClientRect(), h = document.querySelector('#group-table-view .group-table-head').getBoundingClientRect(); const m = innerWidth < 768 || matchMedia('(pointer: coarse)').matches ? 44 : 36;
                return Math.round(h.height) === m && Math.abs(t.top - (v.getBoundingClientRect().top + parseFloat(getComputedStyle(v).paddingTop) + (m - t.height) / 2)) < 1.5; })()`), true, at + 'the title row is one fixed height (no header button here, one on the tabs that have one)');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => [h.textContent, h.getAttribute('scope')])`), [['Item', 'col'], ['Team', 'col'], ['Folder', 'col'], ['When', 'col'], ['Goal', 'col']], at + 'Item, Team, Folder (the rows have one), When, and Goal because a row has one');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.children[0].textContent.trim() + '|' + r.children[1].textContent.trim())`), ['Agent One|team-a', 'Agent Two|team-b'], at + 'a row per waiting agent, with its team');
            assert.equal(await ev(`document.querySelector('#group-table-view tbody tr .group-table-cell-btn').textContent`), 'Ship 169', at + "the goal's cell opens the goal");
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#group-table-title')), c = getComputedStyle(document.querySelector('#group-table-view .group-table-head .session-group-count')); return [t.fontSize, t.fontWeight, c.fontSize, c.fontWeight]; })()`), ['20px', '700', '11px', '600'], at + 'the title is 20/700, its count 11/600');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the table is on the scale');
            await shot(`inbox-one-needs-${w}`);

            // the search names its group and narrows it
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = 'two'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1 && document.querySelectorAll('${pane} li.sb-row .row-btn[data-on-click="inbox-agent-open"]').length === 1`, at + 'the search narrows Needs you', 5000);
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'cleared', 5000);

            // Tasks
            await ev(`document.querySelector('${pane} .sgroup-header[data-group-name="hub-inbox:tasks"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Tasks'`, at + 'Tasks opens its table', 8000);
            assert.equal(await ev(`document.querySelector('${pane} .sidebar-search-input').getAttribute('aria-label')`), 'Search tasks', at + 'the search is named for Tasks now');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => h.textContent)`), ['Task', 'Priority', 'State', 'Team'], at + 'Task, Priority, State, Team');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => [...r.children].map(c => c.textContent.trim()).join('|'))`),
                ['Review the release plan|High|Open|team-a', 'Write the release notes|Medium|In progress|team-a', 'Check the installer|Low|Blocked|team-b'], at + 'rows by priority, in words');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the tasks table is on the scale');
            await ev(`document.querySelector('#group-table-view .group-table-link').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-page .ibx-reply-input') && document.getElementById('inbox-page').checkVisibility()`, at + "the task's page", 10000);
            assert.equal(await ev(`document.querySelector('#inbox-page > .group-back').textContent`), '← Tasks', at + 'back names the group');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#inbox-page .wf-item-title')); return [document.querySelector('#inbox-page .wf-item-title').textContent, t.fontSize, t.fontWeight]; })()`), ['Review the release plan', '17px', '700'], at + 'the title is 17/700');
            assert.match(await ev(`document.querySelector('#inbox-page .item-meta').textContent`), /^From Orchestrator · team-a · High priority · Open/, at + 'one facts line');
            assert.match(await ev(`document.querySelector('#inbox-page .ibx-panel').textContent`), /Please check the plan/, at + "the component shows the task's own text");
            assert.equal(await ev(`getComputedStyle(document.querySelector('#inbox-page .ibx-task-head')).display`), 'none', at + "and not a second heading");
            assert.equal(await ev(`document.querySelectorAll('#inbox-page .ibx-task').length`), 1, at + 'one task is mounted');
            assert.equal(await ev(`document.querySelector('${pane} li.sb-row.active .sb-row-name').textContent`), 'Review the release plan', at + 'the open task is the sidebar'+"'s current row");
            await shot(`inbox-one-task-${w}`);
            await ev(`document.querySelector('#inbox-page > .group-back').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && document.querySelector('#group-table-title').textContent === 'Tasks'`, at + 'back is the table', 8000);

            // Saved
            await ev(`document.querySelector('${pane} .sgroup-header[data-group-name="hub-inbox:saved"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Saved' && document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'Saved opens its table', 10000);
            assert.equal(await ev(`document.querySelector('${pane} .sidebar-search-input').getAttribute('aria-label')`), 'Search saved messages', at + 'the search says it is for saved messages');
            assert.equal(await ev(`document.querySelector('${pane} [data-display-button]').hidden`), false, at + 'Display options is there for Saved');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => h.textContent)`), ['Message', 'Saved', 'State', 'Action'], at + 'Message, Saved, State, Action');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .group-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim() + (c.getAttribute('aria-pressed') === 'true' ? '*' : ''))`), ['Open 2*', 'Done 1'], at + 'Open and Done chips with counts');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody .group-table-cell-btn')].map(b => b.textContent)`), ['Done', 'Done'], at + 'one quiet Done button per row');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the saved table is on the scale');
            await shot(`inbox-one-saved-${w}`);
            // Display options hold Filters and Sort, and no second search box
            await ev(`document.querySelector('${pane} [data-display-button]').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-saved-bar .list-bar-select, #inbox-saved-bar select')`, at + 'Filters and Sort in Display options', 5000);
            assert.equal(await ev(`document.querySelector('#inbox-saved-bar .list-bar-search') === null`), true, at + 'and no second search box');
            await ev(`document.querySelector('${pane} [data-display-button]').click(); true`);
            // Done moves a row to the Done chip, and Reopen brings it back
            await ev(`document.querySelector('#group-table-view tbody .group-table-cell-btn').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'Done moves the row out of Open', 8000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .group-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`), ['Open 1', 'Done 2'], at + 'the counts follow');
            assert.equal(await ev(`document.getElementById('inbox-live').textContent`), 'Marked done', at + 'a polite line says so');
            await ev(`document.querySelectorAll('#group-table-view .group-chip')[1].click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2 && document.querySelector('#group-table-view tbody .group-table-cell-btn').textContent === 'Reopen'`, at + 'the Done chip lists them, with Reopen', 8000);
            await ev(`document.querySelector('#group-table-view tbody .group-table-cell-btn').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'Reopen takes it out of Done', 8000);
            await ev(`document.querySelectorAll('#group-table-view .group-chip')[0].click(); true`);
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
            await ev(`document.querySelector('#group-table-view .group-table-link').click(); true`);
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
            assert.equal(await ev(`document.querySelectorAll('${pane} .sgroup-header .session-group-count')[2].textContent`), '1', at + "and the group's count");

            // nothing waiting: one empty line
            await setAgents(false);
            await ev(`document.querySelector('${pane} .sgroup-header[data-group-name="hub-inbox:needs"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Needs you' && !!document.querySelector('#group-table-view .empty-line')`, at + 'the empty Needs you', 8000);
            assert.deepEqual(await ev(`(() => { const l = document.querySelector('#group-table-view .empty-line'), c = getComputedStyle(l); return [l.textContent, c.fontSize, c.fontWeight]; })()`), ['Nothing needs your input.', '14px', '400'], at + 'one empty line, 14/400');
            await shot(`inbox-one-empty-${w}`);
            await setAgents(true);

            // both themes and 200% text
            if (w === 1280) for (const theme of ['dark', 'light']) for (const zoom of ['', '32px']) {
                const how = at + `${theme}${zoom ? ', 200% text' : ''}: `;
                await setTheme(ev, theme); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await ev(`document.querySelector('${pane} .sgroup-header[data-group-name="hub-inbox:tasks"]').click(); true`);
                await waitFor(`document.querySelector('#group-table-title').textContent === 'Tasks'`, how + 'the tasks table', 8000);
                const au = await auditRegion(ev, ['.sidebar', '#group-table-view']);
                assert.deepEqual(au.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + 'the sidebar and the table: contrast');
                await ev(`document.querySelector('#group-table-view .group-table-link').click(); true`);
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
