// One task row (#7737, UI/UX's design, task_row.js): the same task reads the same wherever it is listed. Step 1: the team page's Tasks tab. On a desktop a table: State (the one chip), Task (the id in tertiary before the title,
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
            await waitFor(`document.querySelectorAll('#team-panel-tasks .task-table tbody tr, #team-panel-tasks .task-col-row').length >= 4`, 'the tasks', 15000);
        };
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); // the page first: the board is made through its own fetch
        for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'One row everywhere', outcome: 'x', done_when: 'y' }); assert.equal(g.status, 201);
        const goal = g.body.id;
        const mk = async (title, assigned, priority) => (await api('POST', `/api/board/${B}/tasks`, { title, body: 'Text of ' + title, created_by: 'orch', priority, goal_id: goal, ...(assigned ? { assigned_to: assigned } : {}) })).body;
        const first = await mk('Build the column', 'dev', 'high'); await mk('Review the patch', 'orch', 'medium'); await mk('A very long title that a table cell cuts with an ellipsis instead of wrapping it onto four lines of text in a narrow window', '', 'low'); await mk('Fourth task', 'dev', 'medium');
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'dev', task_id: first.id || first.task.id })).status, 200); // the server's ids are not ours: this board's first task, whatever number it has

        console.log('1. Desktop: the table');
        await load(1280, false);
        const t = await ev(`(() => { const tb = document.querySelector('#team-panel-tasks .task-table'); const rows = [...tb.querySelectorAll('tbody tr')].map(tr => ({ cells: [...tr.children].map(td => td.textContent.replace(/\\s+/g, ' ').trim()), idFirst: !!tr.querySelector('.task-title-cell > .task-id + .team-row-btn'), chip: tr.querySelector('.goal-chip') && tr.querySelector('.goal-chip').textContent, key: tr.dataset.key }));
            const long = tb.querySelector('tbody tr:nth-child(4) .team-row-btn'); const cs = long && getComputedStyle(long);
            const idCs = getComputedStyle(tb.querySelector('.task-id')), titleCs = getComputedStyle(tb.querySelector('.team-row-btn'));
            return { heads: [...tb.querySelectorAll('thead th')].map(th => th.textContent.trim()), rows, ellipsis: cs && cs.textOverflow + ' ' + cs.whiteSpace, idSize: idCs.fontSize + ' ' + idCs.fontWeight, titleSize: titleCs.fontSize + ' ' + titleCs.fontWeight, goalLink: !!tb.querySelector('.team-link[data-goal-link]'), whenRight: getComputedStyle(tb.querySelector('tbody td:last-child')).textAlign }; })()`);
        assert.deepEqual(t.heads, ['State', 'Task', 'Assigned to', 'Goal', 'Priority', 'Updated'], 'the columns, in the design\'s order');
        assert.ok(t.rows.every(r => r.idFirst), 'the id comes before the title in every row ' + JSON.stringify(t.rows[0]));
        const words = t.rows.map(r => r.chip);
        assert.ok(words.every(w => ['Queued', 'In progress', 'Blocked', 'In review', 'Done'].includes(w)), 'one word set for state ' + JSON.stringify(words));
        assert.ok(words.includes('In progress') && words.includes('Queued'), 'the claimed task is In progress, the others Queued ' + JSON.stringify(words));
        assert.ok(t.rows.some(r => r.cells[4] === 'High') && t.rows.some(r => r.cells[4] === 'Low'), 'priority is a word ' + JSON.stringify(t.rows.map(r => r.cells[4])));
        assert.ok(t.rows.every(r => /ago|just now|today|yesterday|[A-Z][a-z]{2} \\d/.test(r.cells[5])), 'Updated says when ' + JSON.stringify(t.rows.map(r => r.cells[5])));
        assert.equal(t.ellipsis, 'ellipsis nowrap', 'a long title is cut with an ellipsis');
        assert.equal(t.idSize, '12px 400', 'the id is 12/400'); assert.equal(t.titleSize, '14px 600', 'the title is 14/600');
        assert.ok(t.goalLink && t.whenRight === 'right', 'the goal is a link and the last column is right-aligned');
        await shot('task-row-desktop');
        // the goal link keeps its own click; the rest of the row opens the task
        await ev(`document.querySelector('#team-panel-tasks .team-link[data-goal-link]').click(); true`);
        await waitFor(`!!document.querySelector('.goal-split') || !!document.getElementById('goals-detail-title')`, 'the goal opened', 10000);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-tasks .task-table tbody tr').length >= 4`, 'the tasks again', 10000);
        await ev(`document.querySelector('#team-panel-tasks .task-table tbody tr td:nth-child(3)').click(); true`);
        await waitFor(`!!document.getElementById('team-task-title')`, 'the task page from a click on the row', 10000);
        console.log('   ✓');

        console.log('2. Phone: the column, two lines in a 44 px row');
        await load(390, true);
        const p = await ev(`(() => { const rows = [...document.querySelectorAll('#team-panel-tasks .task-col-row')]; return { table: !!document.querySelector('#team-panel-tasks .task-table'), n: rows.length, h: rows.map(r => Math.round(r.getBoundingClientRect().height)), lines: rows.map(r => [r.querySelector('.task-col-line1').textContent.replace(/\\s+/g, ' ').trim(), r.querySelector('.task-col-line2 .goal-chip').textContent, !!r.querySelector('.task-col-priority')]), over: document.documentElement.scrollWidth - innerWidth }; })()`);
        assert.equal(p.table, false, 'no table on a phone'); assert.ok(p.n >= 4 && p.h.every(h => h >= 44), 'every row is at least 44 px ' + JSON.stringify(p.h));
        assert.ok(p.lines[0][0].startsWith('#') && p.lines.some(l => l[1] === 'In progress'), 'line 1 is the id and title, line 2 the chip ' + JSON.stringify(p.lines));
        assert.equal(p.lines.filter(l => l[2]).length, 1, 'the priority shows only for the one High task ' + JSON.stringify(p.lines)); assert.ok(p.over <= 1, 'no sideways scroll ' + p.over);
        await shot('task-row-phone');
        await ev(`document.querySelector('#team-panel-tasks .task-col-btn').click(); true`);
        await waitFor(`!!document.getElementById('team-task-title')`, 'the task page from the phone row', 10000);
        console.log('   ✓');
        console.log('PASS One task row: the Tasks tab as a table and as the phone column');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
