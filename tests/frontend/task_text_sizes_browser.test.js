// Task text is not too big (#9079, the Operator's shots): a task list's row title is the table's body text (13 px, normal weight, not the bold 14 px heading), and the heading of a task in the dock's preview is smaller than a page
// title, two lines at most, with the whole title on hover. A real board with a task whose title is long, on the isolated dev server (removed again). 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const board = 'task-text-' + Date.now().toString(36);
const LONG = 'OPERATOR (shot coral://artifacts/57c54a81b92 text too big): Task list rows at the table\'s body size and normal weight, and the task preview heading smaller, clamped to two lines, with the full title on hover so nothing is lost';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const api = (p, body) => fetch('/api/board/${board}' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => { if (!r.ok) throw new Error('fixture: ' + r.status); });
            await api('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' });
            await api('/tasks', { subscriber_id: 'Boss', title: ${JSON.stringify(LONG)}, body: 'x', assigned_to: 'Boss' });
            await api('/tasks', { subscriber_id: 'Boss', title: 'A short task', body: 'x', assigned_to: 'Boss' });
        })()`);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await openBoardTasksTab({ ev, waitFor }, board);
            await waitFor(`document.querySelectorAll('#board-task-list .board-task-open').length >= 2`, 'task rows', 12000);
            const row = await ev(`(() => { const b = document.querySelector('#board-task-list .board-task-open'), cs = getComputedStyle(b), td = getComputedStyle(b.closest('td')); return { size: cs.fontSize, weight: cs.fontWeight, body: td.fontSize }; })()`);
            assert.equal(row.weight, '400', at + 'the row title is normal weight: ' + JSON.stringify(row)); assert.equal(row.size, '13px', at + 'at the table\'s body size: ' + JSON.stringify(row));
            await ev(`document.querySelector('#board-task-list .board-task-open').click(); true`);
            await waitFor(`!!document.querySelector('#preview-pane .team-task-page #team-task-title')`, 'the task preview', 12000);
            const head = await ev(`(() => { const t = document.querySelector('#preview-pane #team-task-title'), cs = getComputedStyle(t), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3; return { size: parseFloat(cs.fontSize), lines: Math.round(t.getBoundingClientRect().height / lh), title: t.title, text: t.textContent, clamp: cs.webkitLineClamp }; })()`);
            assert.ok(head.size <= 16, at + 'the heading is smaller than a page title: ' + JSON.stringify(head));
            assert.ok(head.lines <= 2 && head.clamp === '2', at + 'two lines at most: ' + JSON.stringify(head));
            assert.equal(head.title, head.text, at + 'the whole title is on hover');
            await shot(`task-text-sizes-${w}`);
        }
        console.log('PASS task text sizes: list titles at body size and normal weight, the preview heading small and clamped with the title on hover');
    } finally { await removeBoards(ev, [board]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
