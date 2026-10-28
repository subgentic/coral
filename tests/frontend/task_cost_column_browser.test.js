// The dock's Tasks table shows Status, Task and Agent only (#7962, the operator: "we probably don't need to show priority, type, cost in this side tab view so we can spend more space on the status, task and agent"), at 680 px with real headers
// and one line per row at 420 px (the dock's rows are not folded, #8792), with no sideways scroll; priority, type, cost and the time are on the main Tasks tab and in the opened task. (The file keeps its name: it began as the cost column's test.)
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const PANELS = require('./helpers/list_bars_panels');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    let ctx;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        ctx = { ev, waitFor, Page, Emulation, client, install, BASE, assert, settle: (c, l) => waitFor(c, l, 10000) };
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        const tasks = PANELS.find(p => p.key === 'tasks');
        await tasks.prepare(ctx);
        await tasks.show(ctx, { w: 1440, theme: 'dark', phone: false }); // the Tasks tab in the dock, 680px wide
        const measure = () => ev(`(() => { const list = document.getElementById('board-task-list'), lr = list.getBoundingClientRect();
            const row = list.querySelector('.board-task-item:not(.board-task-header)');
            return { folded: list.querySelector('.dt-box').classList.contains('dt-folded'), list: Math.round(lr.width), heads: [...list.querySelectorAll('thead th')].filter(h => h.getClientRects().length).map(h => h.dataset.key),
                cells: [...row.querySelectorAll('td.dt-td')].filter(c => c.getClientRects().length > 0 && c.getBoundingClientRect().width > 0).map(c => c.dataset.key),
                gone: ['.board-task-cost', '.board-task-priority-value', '.board-task-source', '.board-task-time'].filter(sel => !!list.querySelector(sel)), scrolls: list.scrollWidth - list.clientWidth,
                name: !!row.querySelector('.board-task-name'), status: !!row.querySelector('.board-task-status-wrap'),
                widths: Object.fromEntries([...list.querySelectorAll('thead th')].filter(h => h.getClientRects().length).map(h => [h.dataset.key, Math.round(h.getBoundingClientRect().width)])), chip: Math.round(list.querySelector('.board-task-status-wrap').getBoundingClientRect().width) }; })()`);
        const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        await ev(`document.querySelector('#board-task-bar .list-bar-toggle') && document.querySelector('#board-task-bar .list-bar-menu:not([hidden])') && document.querySelector('#board-task-bar .list-bar-toggle').click(); true`); // the filter menu out of the way
        let m = await measure();
        assert.deepEqual(m.heads, ['state', 'task'], 'no task has a doer yet: the Agent column is not drawn, a column with nothing in it is not (#9846): ' + JSON.stringify(m));
        await ev(`(async () => { const B = ${JSON.stringify(ctx.TBOARD)}, post = (p, b) => fetch('/api/board/' + B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
            const l = await (await fetch('/api/board/' + B + '/tasks')).json(); const t = (l.tasks || l).find(x => x.title === 'gamma open 0'); await post('/tasks/claim', { subscriber_id: 'worker', task_id: t.id });
            const tasks = await import((window.__coralStatic || '/static/') + 'tasks.js'); await tasks.loadBoardTasks(B); return true; })()`); // one open task is taken: the Agent column has a doer to say
        await waitFor(`[...document.querySelectorAll('#board-task-list thead th')].some(h => h.dataset.key === 'who' && h.getClientRects().length)`, 'the Agent column once a task has a doer', 10000);
        await shot('tasks-dock-680-columns');
        m = await measure();
        assert.ok(m.list >= 560 && m.list < 790, 'the dock is the width in question: ' + m.list);
        assert.equal(m.folded, false, 'the wide dock is unfolded');
        assert.deepEqual(m.heads, ['state', 'task', 'who'], '680 px: the heads are Status, Task and Agent: ' + JSON.stringify(m));
        assert.deepEqual(m.gone, [], 'no priority, type, cost or time cell is drawn in the dock: ' + JSON.stringify(m));
        assert.ok(m.name && m.status, 'the row has its task and its status'); assert.ok(m.scrolls <= 1, 'and it does not scroll sideways');
        assert.ok(m.widths.state <= m.chip + 48, 'Status fits its chip, it does not take a third of the line: ' + JSON.stringify(m.widths) + ' chip ' + m.chip);
        assert.ok(m.widths.task > m.list * 0.6, 'Task takes the rest of the line: ' + JSON.stringify(m.widths));
        await ev(`document.getElementById('agentic-state').style.width = '420px'; true`);
        await waitFor(`document.getElementById('board-task-list').getBoundingClientRect().width < 460`, 'the narrow dock');
        await shot('tasks-dock-420-columns');
        m = await measure();
        assert.ok(m.list < 560, 'a narrow list: ' + m.list); assert.equal(m.folded, false, '420 px: the dock rows are one line at every width, not folded (#8792)');
        assert.deepEqual(m.gone, [], 'the folded row has none of them either: ' + JSON.stringify(m)); assert.ok(m.cells.every(k => ['state', 'task', 'who'].includes(k)), 'only Status, Task and Agent cells: ' + JSON.stringify(m));
        assert.ok(m.scrolls <= 1, 'and it does not scroll sideways');
        console.log('PASS dock Tasks columns');
    } finally { await removeBoards(ev, [ctx && ctx.TBOARD, ctx && ctx.BBOARD]); try { await client.close(); } catch (_) {} } // the panel helper's boards (themes-t-, themes-b-)
})().catch(e => { console.error(e); process.exit(1); });
