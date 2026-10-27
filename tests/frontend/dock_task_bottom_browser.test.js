// #8879: dock tasks share the bottom-half artifact preview; expanding uses the centre, never a narrow third column.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const board = 'task-bottom-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const errors = [];
    const shot = async name => {
        const dir = process.env.CORAL_SCREENSHOT_DIR;
        if (!dir) return;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const api = (p, body) => fetch('/api/board/${board}' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => { if (!r.ok) throw new Error('fixture: ' + r.status); });
            await api('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' });
            for (let i = 1; i <= 6; i++) await api('/tasks', { subscriber_id: 'Boss', title: 'Bottom preview task ' + i, body: 'Keep the chat width and task list.', assigned_to: 'Boss' });
        })()`);
        for (const [name, width, collapsed] of [['desktop-open', 1280, false], ['desktop-collapsed', 1280, true], ['phone', 390, false]]) {
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await openBoardTasksTab({ ev, waitFor }, board);
                await waitFor(`document.querySelectorAll('#board-task-list .board-task-open').length >= 6`, 'task rows');
                const before = await ev(`(() => { window.__bottomOpener = document.querySelector('#board-task-list .board-task-open'); return { chat: document.querySelector('.live-left-column').getBoundingClientRect().width, url: location.pathname }; })()`);
                if (collapsed) await ev(`document.getElementById('agentic-state').classList.add('collapsed'); true`);
                await ev(`window.__bottomOpener.click(); true`);
                await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`, 'task preview');
                assert.equal(await ev(`location.pathname`), before.url, 'agent route stays in place');
                if (width === 390) {
                    assert.equal(await ev(`document.getElementById('preview-pane').classList.contains('preview-phone-full')`), true, 'phone remains full screen');
                } else {
                    const p = await ev(`(() => { const side = document.getElementById('agentic-state'), pane = document.getElementById('preview-pane'), list = document.getElementById('board-task-list'); const s = side.getBoundingClientRect(), r = pane.getBoundingClientRect(), l = list.getBoundingClientRect(); return { parent: pane.parentElement.id, collapsed: side.classList.contains('collapsed'), ratio: r.height / s.height, above: l.top < r.top, chat: document.querySelector('.live-left-column').getBoundingClientRect().width, column: document.getElementById('preview-column').getBoundingClientRect().width }; })()`);
                    assert.equal(p.parent, 'agentic-state', 'task opens in the right sidebar');
                    assert.equal(p.collapsed, false, 'a collapsed sidebar opens for the task');
                    assert.ok(p.ratio >= .45 && p.ratio <= .55, 'preview takes the bottom half: ' + JSON.stringify(p));
                    assert.ok(p.above && p.column === 0 && Math.abs(p.chat - before.chat) <= 1, 'list stays above and chat keeps its open-sidebar width: ' + JSON.stringify(p));
                }
                for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await shot('task-bottom-' + name + '-' + theme); }
                if (width !== 390) {
                    await ev(`document.getElementById('preview-max-btn').click(); true`);
                    await waitFor(`document.querySelector('.live-body').classList.contains('preview-maximised')`, 'expand uses the centre view');
                    assert.equal(await ev(`document.getElementById('preview-pane').parentElement.id`), 'preview-column');
                    for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await shot('task-expanded-' + name + '-' + theme); }
                    await ev(`document.getElementById('preview-max-btn').click(); true`);
                    await waitFor(`document.getElementById('preview-pane').parentElement.id === 'agentic-state' && !document.querySelector('.live-body').classList.contains('preview-maximised')`, 'restore returns to sidebar split');
                } else await ev(`document.getElementById('preview-full-back').click(); true`);
            } catch (e) { errors.push(name + ': ' + e.message); }
        }
        assert.deepEqual(errors, []);
    } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
