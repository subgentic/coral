// One task row (#7737, UI/UX's design, task_row.js): the same task reads the same wherever it is listed: the team page's Tasks tab, the Inbox's Tasks group and a goal's task column. On a desktop a table: State (the one chip), Task (the id in tertiary before the title,
// the title the row's one button), Assigned to, Goal (a link of its own), Priority (a word), Updated; on a phone the column: two lines in a 44 px row (id and title, then the chip, who, and the priority only when High). Real board on
// the isolated dev server, removed again.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'tr-' + Date.now().toString(36);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await ev(`new Promise(r => setTimeout(r, 400))`); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const load = async (w, mobile) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks .dt-table tbody tr').length >= 5`, 'the tasks', 15000);
        };
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); // the page first: the board is made through its own fetch
        for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'One row everywhere', outcome: 'x', done_when: 'y' }); assert.equal(g.status, 201);
        const goal = g.body.id;
        const mk = async (title, assigned, priority) => (await api('POST', `/api/board/${B}/tasks`, { title, body: 'Text of ' + title, created_by: 'orch', priority, goal_id: goal, ...(assigned ? { assigned_to: assigned } : {}) })).body;
        const first = await mk('Build the column', 'dev', 'high'); await mk('Review the patch', 'orch', 'medium'); await mk('A very long title that a table cell cuts with an ellipsis instead of wrapping it onto four lines of text in a narrow window', '', 'low'); await mk('Fourth task', 'dev', 'medium'); await mk('Mine to do', 'Operator', 'high');
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'dev', task_id: first.id || first.task.id })).status, 200); // the server's ids are not ours: this board's first task, whatever number it has

        console.log('1. Desktop: the data table');
        await load(1280, false);
        const t = await ev(`(() => { const tb = document.querySelector('#team-panel-tasks .dt-table'); const rows = [...tb.querySelectorAll('tbody tr')].map(tr => ({ cells: [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\\s+/g, ' ').trim()), noId: !tr.querySelector('.dt-id'), hover: /^Task #\\d+$/.test(tr.querySelector('.dt-title-cell').title), chip: tr.querySelector('.goal-chip') && tr.querySelector('.goal-chip').textContent, key: tr.dataset.key }));
            const long = tb.querySelector('tbody tr:nth-child(4) .dt-primary'); const cs = long && getComputedStyle(long);
            const titleCs = getComputedStyle(tb.querySelector('.dt-primary'));
            return { heads: [...tb.querySelectorAll('thead th')].map(th => th.textContent.replace(/[↑↓↕]/g, '').trim()).filter(Boolean), rows, ellipsis: cs && cs.textOverflow + ' ' + cs.whiteSpace, titleSize: titleCs.fontSize + ' ' + titleCs.fontWeight, goalLink: !!tb.querySelector('.dt-link[data-goal-link]'), whenRight: getComputedStyle(tb.querySelector('tbody td[data-key="updated"]')).textAlign }; })()`);
        assert.deepEqual(t.heads, ['State', 'Task', 'Who', 'Goal', 'Updated'], 'the columns, in the design\'s order (no Priority, #8784)');
        assert.ok(t.rows.every(r => r.noId && r.hover), 'no task number before the title; it is the row\'s hover title (#8784) ' + JSON.stringify(t.rows[0]));
        const words = t.rows.map(r => r.chip);
        assert.ok(words.every(w => ['Queued', 'In progress', 'Blocked', 'In review', 'Done'].includes(w)), 'one word set for state ' + JSON.stringify(words));
        assert.ok(words.includes('In progress') && words.includes('Queued'), 'the claimed task is In progress, the others Queued ' + JSON.stringify(words));
        assert.ok(!t.rows.some(r => r.cells.includes('High') || r.cells.includes('Low')), 'no priority word in a row ' + JSON.stringify(t.rows.map(r => r.cells)));
        assert.ok(t.rows.every(r => /ago|just now|today|yesterday|[A-Z][a-z]{2} \\d/.test(r.cells[r.cells.length - 1])), 'Updated says when ' + JSON.stringify(t.rows.map(r => r.cells)));
        assert.equal(t.ellipsis, 'ellipsis nowrap', 'a long title is cut with an ellipsis');
        const levels = await ev(`(() => { const r = document.querySelector('#team-panel-tasks .dt-table tbody tr'); const c = sel => { const e = r.querySelector(sel), cs = getComputedStyle(e); return cs.fontSize + ' ' + cs.fontWeight + ' ' + cs.color; }; return { title: c('.dt-primary'), who: c('td[data-key="who"]'), when: c('td[data-key="updated"]'), heights: [...document.querySelectorAll('#team-panel-tasks .dt-table tbody tr')].map(x => Math.round(x.getBoundingClientRect().height)) }; })()`);
        assert.ok(levels.title.startsWith('13px 400') && levels.who.startsWith('13px 400') && levels.when.startsWith('12px 400'), 'title 13/400, who 13/400, updated 12/400 ' + JSON.stringify(levels));
        assert.equal(new Set([levels.title.split(' ').slice(2).join(' '), levels.who.split(' ').slice(2).join(' '), levels.when.split(' ').slice(2).join(' ')]).size, 3, 'three colour levels: primary, secondary, tertiary ' + JSON.stringify(levels));
        assert.ok(levels.heights.every(h => h <= 38), 'every row is one line, not wrapped (dense) ' + JSON.stringify(levels.heights));
        assert.equal(t.titleSize, '13px 400', 'the title is 13/400');
        assert.ok(t.goalLink && t.whenRight === 'right', 'the goal is a link and the last column is right-aligned');
        await shot('task-row-desktop');
        // the goal link keeps its own click; the rest of the row opens the task
        await ev(`document.querySelector('#team-panel-tasks .dt-link[data-goal-link]').click(); true`);
        await waitFor(`!!document.querySelector('.goal-split') || !!document.getElementById('goals-detail-title')`, 'the goal opened', 10000);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-tasks .dt-table tbody tr').length >= 5`, 'the tasks again', 10000);
        await ev(`document.querySelector('#team-panel-tasks .dt-table tbody tr td[data-key="who"]').click(); true`);
        await waitFor(`!!document.getElementById('team-task-title')`, 'the task page from a click on the row', 10000);
        console.log('   ✓');

        console.log('2. Phone: the same table folded to two lines in a 44 px row');
        await load(390, true);
        await waitFor(`!!document.querySelector('#team-panel-tasks .dt-box').classList.contains('dt-folded')`, 'the table folds on a phone');
        const p = await ev(`(() => { const rows = [...document.querySelectorAll('#team-panel-tasks .dt-table tbody tr')]; return { head: getComputedStyle(document.querySelector('#team-panel-tasks thead')).display, n: rows.length, h: rows.map(r => Math.round(r.getBoundingClientRect().height)), line1: rows.map(r => r.querySelector('td.dt-line-1').textContent.replace(/\\s+/g, ' ').trim()), chips: rows.map(r => r.querySelector('.goal-chip').textContent), prio: rows.filter(r => r.querySelector('td[data-key="priority"]')).length, over: document.documentElement.scrollWidth - innerWidth }; })()`);
        assert.equal(p.head, 'none', 'no header row on a phone'); assert.ok(p.n >= 5 && p.h.every(h => h >= 44), 'every row is at least 44 px ' + JSON.stringify(p.h));
        assert.ok(!p.line1[0].startsWith('#') && p.chips.includes('In progress'), 'line 1 is the title (no number), line 2 the chip ' + JSON.stringify(p));
        assert.equal(p.prio, 0, 'no Priority cell on a phone row ' + JSON.stringify(p)); assert.ok(p.over <= 1, 'no sideways scroll ' + p.over);
        await shot('task-row-phone');
        await ev(`document.querySelector('#team-panel-tasks .dt-primary').click(); true`);
        await waitFor(`!!document.getElementById('team-task-title')`, 'the task page from the phone row', 10000);
        console.log('   ✓');

        // the same row in the Inbox's Tasks group (my tasks) and in the goal's column
        const word = (rowSel, chip) => `[...document.querySelectorAll('${rowSel}')].map(r => r.querySelector('${chip}').textContent)`;
        for (const [w, mobile, label] of [[1280, false, 'desktop'], [390, true, 'phone']]) {
            console.log(`3. The Inbox's Tasks group, ${label}`);
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length >= 1`, 'the inbox tasks', 15000);
            if (mobile) await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-folded')`, 'the Inbox table folds on a phone', 5000);
            const ib = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr')]; const box = document.querySelector('#group-table-view .dt-box'); return { folded: box.classList.contains('dt-folded'), heads: [...document.querySelectorAll('#group-table-view th')].map(h => h.textContent.replace(/[↑↓↕]/g, '').trim()).filter(Boolean), n: rows.length, words: rows.map(r => r.querySelector('.goal-chip').textContent), noId: rows.every(r => !r.querySelector('.dt-id') && /^Task #\\d+$/.test(r.querySelector('.dt-title-cell').title)), h: rows.map(r => Math.round(r.getBoundingClientRect().height)) }; })()`);
            assert.equal(ib.n, 1, 'one task is assigned to the operator ' + JSON.stringify(ib)); assert.deepEqual(ib.words, ['Queued'], 'the same word as the Tasks tab (not "Open") ' + JSON.stringify(ib)); assert.ok(ib.noId, 'no number before the title; it is the hover title (#8784) ' + JSON.stringify(ib));
            if (mobile) assert.ok(ib.folded && ib.h.every(h => h >= 44), 'a phone: the folded two-line row, 44 px ' + JSON.stringify(ib)); else assert.deepEqual(ib.heads, ['State', 'Task', 'Team', 'Updated'], 'a desktop: the table ' + JSON.stringify(ib));
            await shot(`task-row-inbox-${label}`);
            console.log('   ✓');
        }
        console.log('4. The goal\'s column');
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals', item: ${goal} }); true`);
            await waitFor(`!!document.querySelector('.goal-split')`, 'the goal page', 15000);
            await waitFor(`document.querySelectorAll('.goal-list .dt-table tbody tr').length >= 5`, 'the goal list', 10000);
            const gc = await ev(`(() => { const rows = [...document.querySelectorAll('.goal-list .dt-table tbody tr')]; return { words: [...new Set(rows.map(r => r.querySelector('.goal-chip').textContent))].sort(), noId: rows.every(r => !r.querySelector('.dt-id') && !/^#\\d/.test(r.querySelector('.dt-title-cell').textContent.trim())), hover: rows.every(r => /^Task #\\d+$/.test(r.querySelector('.dt-title-cell').title)), named: rows.every(r => /^Open task #\\d+: /.test(r.querySelector('.dt-primary').getAttribute('aria-label'))), priority: rows.filter(r => r.querySelector('td[data-key="priority"]')).length, head: [...document.querySelectorAll('.goal-list .dt-table thead th')].some(h => /priority/i.test(h.textContent)), h: rows.map(r => Math.round(r.getBoundingClientRect().height)), folded: document.querySelector('.goal-list .dt-box').classList.contains('dt-folded') }; })()`);
            assert.deepEqual(gc.words, ['In progress', 'Queued'], 'the same word set ' + JSON.stringify(gc)); assert.ok(gc.noId, 'no task number before the title (#8784)'); assert.ok(gc.hover && gc.named, 'the number stays reachable: the row title and the button name ' + JSON.stringify(gc)); assert.equal(gc.priority, 0, 'no Priority column in the goal column'); assert.equal(gc.head, false, 'no Priority heading'); assert.ok(!gc.folded && gc.h.every(h => h <= 64), 'the list is one line a row (#8914) ' + JSON.stringify(gc));
            await shot(`task-row-goal-column-${mobile ? 'phone' : 'desktop'}`);
        }
        console.log('   ✓');
        console.log('PASS One task row: the Tasks tab as a table and as the phone column');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
