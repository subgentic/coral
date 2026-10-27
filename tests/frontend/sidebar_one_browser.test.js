// One sidebar for every tab (#7443, UI/UX's one-sidebar design): the header's parts (search, Hide) are in the same pixels on the Agents, Chats and Automations tabs at 1280 and 1024 px; every text in
// the sidebar is the page's font; a group's name opens it as a table in the centre while its chevron only folds it, and the item opened from the table says "‹ <group>" to go back; Hide turns
// the column into a 56 px rail that is the tab's own; the Automations tab's "New job" is on its folder's toolbar; no sideways scroll at 390 px. Drives Chrome over CDP through
// agent_view_harness.js with the history list and the jobs answered at the page's fetch.
// The main panes follow UI/UX's part-2 rules (audit c2596330): a group's table is titled 20/700 with its count (11/600) and its columns are Chat, Agent, When, Ran and Job, Schedule, Last run, Next;
// an item's page has its own "← group" link, a 17/700 title and a line under it; the job page's actions are a pinned bar with the primary last; and every text on those pages is on the scale.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

const STUB = `(() => {
    const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const at = (dd, hh) => { const d = new Date(); d.setDate(d.getDate() - dd); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
    const rows = [ { session_id: 'aaaaaa1', title: 'The newest chat', source_type: 'claude', display_name: 'Ada', last_timestamp: at(0, 12) },
        { session_id: 'aaaaaa2', title: 'The second chat', source_type: 'claude', display_name: 'Ada', last_timestamp: at(0, 9) },
        { session_id: 'bbbbbb1', title: 'Yesterday\\'s chat', source_type: 'claude', display_name: 'Grace', last_timestamp: at(1, 15) } ];
    const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', job_type: 'prompt', workflow_id: null, created_at: at(3, 1), updated_at: at(3, 1), paused_reason: '', consecutive_failures: 0 };
    const jobs = [ { ...base, id: 1, name: 'nightly-build', cron_expr: '0 2 * * *', next_fire_at: new Date(Date.now() + 7200000).toISOString(), last_run: null },
        { ...base, id: 2, name: 'summarize-the-day', cron_expr: '0 18 * * 1-5', next_fire_at: new Date(Date.now() + 9000000).toISOString(), last_run: null },
        { ...base, id: 3, name: 'weekly-cleanup', cron_expr: '0 9 * * 1', enabled: 0, next_fire_at: null, last_run: null } ];
    const chat = sid => json({ session_id: sid, agent_type: 'claude', messages: [{ type: 'user', content: 'Hello' }, { type: 'assistant', text: 'Hi' }], total: 2, start: 0 });
    window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
        if (p === '/api/sessions/history') return json({ sessions: rows, total: rows.length, page: 1, page_size: 50 });
        if (/^\\/api\\/sessions\\/history\\/[a-z0-9]+$/.test(p)) return chat(p.split('/').pop());
        if (/^\\/api\\/sessions\\/history\\/[a-z0-9]+\\//.test(p)) return json([]);
        if (p === '/api/scheduled/jobs') return json({ jobs });
        if (/^\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(p)) return json({ runs: [] });
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const pane = tab => `.sidebar-pane[data-pane="${tab}"]`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`);
    // every visible text of a page is the page's font (the code and icons aside) and one of the scale's sizes and weights
    const ON_SCALE = `(root, sizes) => { const want = getComputedStyle(document.body).fontFamily, out = [];
        for (const e of root.querySelectorAll('*')) { if (!e.getClientRects().length || e.matches('.material-icons, pre, code, svg, svg *')) continue; if (e.closest('pre, code, .sched-path')) continue;
            if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
            const c = getComputedStyle(e), px = parseFloat(c.fontSize); const label = e.tagName + '.' + e.className + ' "' + e.textContent.trim().slice(0, 24) + '" ' + c.fontSize + '/' + c.fontWeight;
            if (c.fontFamily !== want) out.push('family ' + label); else if (!sizes.includes(px)) out.push('size ' + label); else if (!['400', '500', '600', '700'].includes(c.fontWeight)) out.push('weight ' + label); }
        return out; }`;
    const openTab = async tab => {
        await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`);
        if (tab === 'history') await require('./helpers/hub_chats').showHubChats(ev); // the hub's Chats list: a local Coral's Chats are the Inbox's folders (#7776)
        await waitFor(`!document.querySelector('${pane(tab)}').hidden`, `the ${tab} pane`, 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [1024, 768, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

            // Chats and Automations have the header, the groups (folders) and the way to act
            await openTab('history');
            await waitFor(`document.querySelectorAll('${pane('history')} li[data-session-id]').length === 3`, at + 'three chats', 10000);
            const days = await ev(`[...document.querySelectorAll('${pane('history')} .sgroup-header .group-name-text')].map(e => e.textContent)`);
            assert.deepEqual(days, ['Today', 'Yesterday'], at + 'Chats are grouped by day');
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane('history')} .sgroup-header .session-group-count')].map(e => e.textContent)`), ['2', '1'], at + 'with their counts');
            await openTab('automations');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'three jobs', 10000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane('automations')} .view-list-item')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`), ['Running now0', 'Failed0', 'Jobs3', 'Workflows0'], at + 'Automations holds its folders with their counts');

            // no sideways scroll
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll on Jobs');

            // every text of the sidebar is the page's font
            for (const tab of ['history', 'automations']) {
                await openTab(tab);
                const odd = await ev(`(() => { const want = getComputedStyle(document.body).fontFamily; const out = [];
                    for (const e of document.querySelectorAll('${pane(tab)} *')) { if (!e.getClientRects().length || e.matches('.material-icons')) continue; /* the icon font draws icons, not text */ const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || e.matches('input'); if (!own) continue;
                        const f = getComputedStyle(e).fontFamily; if (f !== want) out.push(e.tagName + '.' + e.className + ': ' + f); }
                    return out; })()`);
                assert.deepEqual(odd, [], at + `${tab}: every text is the page's font`);
            }

            if (mobile) {
                // the phone's Jobs folder IS the screen: the table with the folders' select over it, and the centre's job page is not shown until a job is chosen
                await openTab('automations');
                await waitFor(`document.getElementById('group-table-view').getClientRects().length > 0 && !!document.querySelector('#group-table-view .view-list-select')`, at + 'the Jobs folder is the phone page', 8000);
                assert.equal(await ev(`document.getElementById('scheduler-detail').getClientRects().length`), 0, at + 'the centre is not shown until a job is chosen');
                await shot(`sidebar-one-jobs-${w}`);
                await ev(`document.querySelector('#group-table-view tbody tr[data-key] .dt-primary').click(); true`);
                await waitFor(`!!document.querySelector('#scheduler-detail .item-bar') && document.querySelector('#scheduler-detail').getClientRects().length > 0`, at + "the job's page is a screen of its own", 8000);
                assert.equal(await ev(`document.getElementById('group-table-view').getClientRects().length`), 0, at + 'and the table is not under it');
                assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-back').textContent.trim()`), '\u2190 Jobs', at + 'with the way back');
                await shot(`sidebar-one-job-${w}`);
                await ev(`document.querySelector('#scheduler-detail .sched-back').click(); true`);
                await waitFor(`document.getElementById('group-table-view').getClientRects().length > 0 && document.getElementById('scheduler-detail').getClientRects().length === 0`, at + 'back is the table', 4000);
                // a chat on a phone: its tabs' content and its pinned bar are both on the screen (the bar must not push the page's content off it)
                await ev(`window.selectHistorySession('aaaaaa1'); true`);
                await waitFor(`document.getElementById('history-session-view').checkVisibility() && document.getElementById('btn-resume-session').getClientRects().length > 0`, at + 'the chat on a phone', 8000);
                await ev(`document.querySelector('.history-tab-btn[data-tab="activity"]').click(); true`);
                await waitFor(`document.getElementById('history-tab-activity').checkVisibility()`, at + 'the activity tab', 8000);
                const geo = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; }; const body = document.querySelector('#history-tab-activity .agentic-events-body'); return { vh: innerHeight, bar: r(document.querySelector('#history-session-view > .item-bar')), body: body ? r(body) : null, tabs: r(document.querySelector('#history-session-view .history-tabs')), scrollY: Math.round(scrollY), docH: document.documentElement.scrollHeight }; })()`);
                await shot(`sidebar-one-chat-activity-${w}`);
                assert.ok(geo.body && geo.body[0] < geo.vh && geo.bar[1] <= geo.vh + 1, at + `the activity body and the chat's bar are on the screen: ${JSON.stringify(geo)}`);
                continue;
            }

            // the header's parts are in the same pixels on every tab
            const parts = {};
            for (const tab of ['agents', 'history', 'automations']) {
                await openTab(tab);
                parts[tab] = { search: await rect(`${pane(tab)} .sidebar-search-input`), hide: await rect(`${pane(tab)} .sidebar-hide-btn`), header: await rect(`${pane(tab)} .sidebar-header`), toggle: await rect(`${pane(tab)} [data-group-toggle]`) };
                await shot(`sidebar-one-${tab}-${w}`);
            }
            for (const tab of ['history', 'automations']) {
                assert.deepEqual(parts[tab].hide, parts.agents.hide, at + `Hide is in the same place on ${tab} as on Agents`);
                assert.deepEqual(parts[tab].search.slice(0, 2), parts.agents.search.slice(0, 2), at + `the search starts in the same place on ${tab}`);
                assert.equal(parts[tab].search[3], parts.agents.search[3], at + `the search is as tall on ${tab}`);
                assert.equal(parts[tab].header[3] >= parts.agents.header[3] - 1 && parts[tab].header[3] <= parts.agents.header[3] + 1, true, at + `the header is as tall on ${tab}`);
            }
            assert.equal(parts.automations.toggle, null, at + 'Automations has folders, which do not fold: no Expand or collapse all');
            assert.ok(parts.history.toggle && parts.history.toggle[0] + parts.history.toggle[2] <= parts.history.hide[0], at + 'it is left of Hide');

            // the chevron only folds; the name opens the table
            await openTab('history');
            await waitFor(`!!document.querySelector('#group-table-view table.dt-table') && document.getElementById('group-table-view').checkVisibility()`, at + 'the tab opens on its first group as a table', 8000);
            assert.equal(await ev(`document.querySelector('#group-table-title').textContent`), 'Today', at + 'the first group is Today');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => [h.textContent, h.getAttribute('scope')])`), [['Chat', 'col'], ['Agent', 'col'], ['When', 'col'], ['Ran', 'col']], at + 'a real table with column headers');
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr').length`), 2, at + 'two chats today');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#group-table-title')), c = getComputedStyle(document.querySelector('#group-table-view .group-table-head .session-group-count')); return [t.fontSize, t.fontWeight, c.fontSize, c.fontWeight]; })()`), ['20px', '700', '11px', '600'], at + "the table's title is 20/700 and its count 11/600");
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), [11, 12, 13, 14, 17, 20])`), [], at + 'every text of the chats table is on the scale');
            const todayTitle = await rect('#group-table-title');
            { // a mouse click on the title shows no focus box; the keyboard's focus shows the ring (QA Reviewer 2's #7577 note)
                const ring = () => ev(`(() => { const t = document.querySelector('#group-table-title'); return { focused: document.activeElement === t, ring: getComputedStyle(t).outlineStyle }; })()`);
                const [x, y, w, h] = todayTitle;
                await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: x + w / 2, y: y + h / 2, button: 'left', clickCount: 1 });
                await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: x + w / 2, y: y + h / 2, button: 'left', clickCount: 1 });
                assert.deepEqual(await ring(), { focused: true, ring: 'none' }, at + 'a mouse click on the group title shows no focus box');
                await ev(`document.activeElement.blur(); true`);
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
                await ev(`document.querySelector('#group-table-title').focus(); true`);
                assert.deepEqual(await ring(), { focused: true, ring: 'solid' }, at + 'the title focused after a key shows the ring');
                await ev(`document.activeElement.blur(); true`);
            }
            await ev(`document.querySelector('${pane('history')} .sgroup-header[data-group-name="history:day-yesterday"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Yesterday'`, at + 'Yesterday opens its table', 8000);
            { const t = await rect('#group-table-title'); assert.deepEqual([t[0], t[1], t[3]], [todayTitle[0], todayTitle[1], todayTitle[3]], at + 'the title does not move from group to group'); }
            await ev(`document.querySelector('${pane('history')} .sgroup-header[data-group-name="history:day-today"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Today'`, at + 'back on Today', 8000);

            // a chat from the table: its page has its own way back, a 17/700 title and who, when and how long under it
            await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
            await waitFor(`document.getElementById('history-session-view').checkVisibility() && document.getElementById('history-back').checkVisibility()`, at + 'the chat opens with the way back', 8000);
            assert.equal(await ev(`document.getElementById('history-back').textContent`), '\u2190 All chats', at + 'back names the Inbox folder it came from (a local Coral: #7776; the hub\'s way back names the day group)');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.getElementById('history-session-title')); return [t.fontSize, t.fontWeight]; })()`), ['20px', '700'], at + "an item's title is 20/700 (the item page title, Goal #84)");
            assert.match(await ev(`document.getElementById('history-session-meta').textContent`), /^Ada \u00b7 (today|just now|\d+ min ago)/, at + 'who and when under the title (the fixture is today at 12:00: within the hour after it the page says "N min ago", as it does for anything under an hour)');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#history-session-view > .item-bar > .btn')].filter(b => b.getClientRects().length).map(b => b.textContent.trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['Details', '+ Tag', 'Resume*'], at + "the chat's actions are its bar, the primary last");
            assert.equal(await ev(`document.querySelector('#history-session-view .history-title-row .btn:not(.mobile-history-back)') === null`), true, at + 'and none is beside the title');
            assert.equal(await ev(`(() => { const r = document.querySelector('#history-session-view > .item-bar').getBoundingClientRect(); return r.bottom <= innerHeight + 1; })()`), true, at + 'the bar is on screen');
            await shot(`sidebar-one-chat-${w}`);
            // The way back to the table, the sidebar row's page and the group's chevron are the hub's Chats list (history_list.js, #7776): a local Coral's way back is the Inbox folder (mailbox_chats, inbox_one).
            // the way back is the Inbox folder's table: its source registers when inbox_sidebar.js has loaded (lazy since #8670), so wait for that, or the click lands on nothing
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(() => true)`);
            await ev(`document.getElementById('history-back').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'back is the table', 8000);
            // the same page from a sidebar row has the same way back; the chevron folds without opening a table
            await ev(`document.querySelector('${pane('history')} li[data-session-id="aaaaaa1"] .row-btn').click(); true`);
            await waitFor(`document.getElementById('history-session-view').checkVisibility() && document.getElementById('history-back').checkVisibility()`, at + 'a sidebar row opens the same page', 8000);
            await ev(`document.querySelector('${pane('history')} .sgroup-header .group-chevron').click(); true`);
            assert.equal(await ev(`document.querySelector('${pane('history')} .sgroup-header .group-chevron').getAttribute('aria-expanded')`), 'false', at + 'the chevron folds');
            assert.equal(await ev(`document.querySelectorAll('${pane('history')} li[data-session-id]').length`), 1, at + 'the folded group hides its rows');
            assert.equal(await ev(`document.getElementById('group-table-view').checkVisibility()`), false, at + 'folding opens no table');
            await ev(`document.querySelector('${pane('history')} .sgroup-header').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'the name opens the table', 8000);

            // Jobs: the table, the job's page and its pinned bar
            await openTab('automations');
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && document.querySelector('#group-table-title').textContent === 'Jobs'`, at + 'Automations opens on Jobs as a table', 8000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view table')[0].querySelectorAll('th')].map(h => h.querySelector('.dt-sort > span').textContent)`), ['Job', 'Schedule', 'Last run', 'Next'], at + 'the jobs table columns');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), [11, 12, 13, 14, 17, 20])`), [], at + 'every text of the jobs table is on the scale');
            await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('#scheduler-detail .item-bar') && document.querySelector('#scheduler-detail .back-link').checkVisibility()`, at + "the job's page", 8000);
            assert.equal(await ev(`document.querySelector('#scheduler-detail .back-link').textContent`), '\u2190 Jobs', at + 'the job page has its way back');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#scheduler-detail .sched-header h2')); return [t.fontSize, t.fontWeight]; })()`), ['17px', '700'], at + "the job's name is 17/700");
            assert.match(await ev(`document.querySelector('#scheduler-detail .sched-status-line').textContent`), /^Active \u00b7 /, at + 'a status line under the name');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-facts dt')].slice(0, 3).map(e => { const c = getComputedStyle(e), v = getComputedStyle(e.nextElementSibling); return [c.fontSize, c.fontWeight, v.fontSize, v.fontWeight].join(' '); })`), ['13px 500 13px 400', '13px 500 13px 400', '13px 500 13px 400'], at + 'facts: labels 13/500, values 13/400');
            assert.equal(await ev(`!!document.querySelector('#scheduler-detail .sched-prompt-shown .sched-prompt')`), true, at + 'a short prompt is shown, not folded');
            assert.equal(await ev(`getComputedStyle(document.querySelector('#scheduler-detail .sched-prompt')).fontFamily === getComputedStyle(document.body).fontFamily`), true, at + "a prompt is the person's writing: the product font");
            assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .item-bar .btn')].filter(b => b.getClientRects().length).map(b => b.textContent.trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['More', 'Edit', 'Pause*'], at + 'the pinned bar: More, Edit, Pause, the primary last');
            const bar = await ev(`(() => { const r = document.querySelector('#scheduler-detail .item-bar').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; })()`);
            assert.equal(bar, true, at + 'the bar is on screen without scrolling');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('scheduler-detail'), [11, 12, 13, 14, 17, 20])`), [], at + "every text of the job's page is on the scale");
            await shot(`sidebar-one-job-${w}`);
            await ev(`document.querySelector('#scheduler-detail .back-link').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'back is the jobs table', 8000);

            // Hide turns the column into the tab's own rail
            await openTab('history');
            await ev(`document.querySelector('${pane('history')} .sidebar-hide-btn').click(); true`);
            await waitFor(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`, at + 'the rail', 4000);
            assert.equal(await ev(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`), 56, at + 'the rail is 56 px');
            assert.equal(await ev(`document.getElementById('sidebar-rail-search').getAttribute('aria-label')`), 'Search chats', at + "the rail's search is named for the tab");
            assert.equal(await ev(`document.getElementById('sidebar-rail-new').hidden`), true, at + 'Chats has no pinned action, so no rail action');
            await shot(`sidebar-one-rail-chats-${w}`);
            await openTab('automations');
            assert.equal(await ev(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`), false, at + "the rail is each tab's own: Automations is open");
            assert.equal(await ev(`document.getElementById('sidebar-rail-new').hidden`), true, at + 'Automations has no pinned action (New job is on its folder\'s toolbar), so no rail action');
            await openTab('history');
            assert.equal(await ev(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`), true, at + 'Chats is still the rail');
            await ev(`document.querySelector('.sidebar-rail-btn').click(); true`);
            await waitFor(`!document.querySelector('.layout').classList.contains('sidebar-collapsed')`, at + 'the rail opens again', 4000);

            // Jobs: New job is on the folder's toolbar, not pinned in the sidebar
            await openTab('automations');
            await waitFor(`!!document.querySelector('#group-table-view .team-tb-action')`, at + 'the folder toolbar has its action', 8000);
            assert.equal(await ev(`document.querySelector('#group-table-view .team-tb-action').textContent.trim()`), 'New job', at + 'New job is on the folder toolbar');
            assert.equal(await ev(`!!document.querySelector('${pane('automations')} .sidebar-footer')`), false, at + 'and nothing is pinned in the sidebar');
            await ev(`document.querySelector('#group-table-view .team-tb-action').click(); true`);
            await waitFor(`[...document.querySelectorAll('.modal, dialog')].some(m => m.getClientRects().length > 0 && /cron|schedule/i.test(m.textContent))`, at + 'it opens the job editor', 8000);
            await ev(`window.hideJobModal && window.hideJobModal(); true`);

            // both themes, and 200% text: the tables and pages stay readable (contrast), inside the screen, with nothing cut off
            if (w === 1280) for (const theme of ['dark', 'light']) for (const zoom of ['', '32px']) {
                const how = at + `${theme}${zoom ? ', 200% text' : ''}: `;
                await setTheme(ev, theme); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await openTab('automations');
                await waitFor(`document.getElementById('group-table-view').checkVisibility() && !!document.querySelector('#group-table-view .dt-primary')`, how + 'the jobs table', 8000);
                for (const [what, roots] of [['the sidebar and the table', ['.sidebar', '#group-table-view']]]) {
                    const au = await auditRegion(ev, roots);
                    assert.deepEqual(au.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + `${what}: contrast`);
                }
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.getElementById('group-table-view').getBoundingClientRect().right <= innerWidth + 1`), true, how + 'the table is inside the screen');
                await shot(`jobs-table-${theme}${zoom ? '-200' : ''}`);
                await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
                await waitFor(`!!document.querySelector('#scheduler-detail .item-bar')`, how + "the job's page", 8000);
                const au2 = await auditRegion(ev, ['#scheduler-detail']);
                assert.deepEqual(au2.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + "the job's page: contrast");
                const cut = await ev(`(() => { const bar = document.querySelector('#scheduler-detail .item-bar'); return [...bar.querySelectorAll('.btn')].filter(b => b.getClientRects().length && (b.getBoundingClientRect().right > innerWidth || b.getBoundingClientRect().bottom > innerHeight + 1)).length; })()`);
                assert.equal(cut, 0, how + "the job's bar buttons are all on screen");
            }
            await setTheme(ev, 'dark'); await ev(`document.documentElement.style.fontSize = ''; true`);
        }
        console.log('PASS one sidebar: the header is the same on every tab, groups open tables, the rail is the tab\'s own');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
