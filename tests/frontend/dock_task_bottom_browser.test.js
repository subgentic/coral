// #8879: dock tasks share the bottom-half artifact preview; expanding does what a file's dock button does: the column beside the chat, resizable with its width kept (#9076).
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
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
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
                    // Expand (#9076, the Operator): the task does what a file does when it is popped into the centre from the sidebar (the dock button's move): the full-height column beside the chat, with the column's own handle and its width kept per browser.
                    await ev(`document.getElementById('preview-max-btn').click(); true`);
                    await waitFor(`document.getElementById('preview-pane').parentElement.id === 'preview-column' && getComputedStyle(document.getElementById('preview-column')).display !== 'none'`, 'expand uses the column, as a file does');
                    const ex = await ev(`(() => { const c = document.getElementById('preview-column').getBoundingClientRect(), chat = document.querySelector('.live-left-column').getBoundingClientRect(), h = document.getElementById('preview-column-resize-handle'); return { maximised: document.querySelector('.live-body').classList.contains('preview-maximised'), col: Math.round(c.width), chat: Math.round(chat.width), handle: h.getAttribute('role'), handleShown: h.getClientRects().length > 0, dock: localStorage.getItem('coral-preview-pane-dock') }; })()`);
                    assert.equal(ex.maximised, false, 'the chat is not covered: ' + JSON.stringify(ex));
                    assert.ok(ex.chat >= 240 && ex.handleShown && ex.handle === 'separator' && ex.dock === 'column', 'the column has its resize handle, the chat keeps its room and the dock is kept: ' + JSON.stringify(ex));
                    await ev(`document.getElementById('preview-column-resize-handle').focus(); true`);
                    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
                    const narrower = await ev(`Math.round(document.getElementById('preview-column').getBoundingClientRect().width)`);
                    assert.ok(narrower < ex.col, 'the handle resizes the column (ArrowRight narrows it): ' + ex.col + ' to ' + narrower);
                    assert.equal(await ev(`localStorage.getItem('coral-preview-column-width')`), String(narrower), 'and the width is kept, as for a file');
                    for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await shot('task-expanded-' + name + '-' + theme); }
                    // one more press maximises it over the chat as for a file; the dock button returns it to the sidebar
                    await ev(`document.getElementById('preview-max-btn').click(); true`);
                    await waitFor(`document.querySelector('.live-body').classList.contains('preview-maximised')`, 'a second press maximises it, as for a file');
                    await ev(`document.getElementById('preview-max-btn').click(); true`);
                    await waitFor(`!document.querySelector('.live-body').classList.contains('preview-maximised')`, 'and restores it beside the chat');
                    await ev(`document.getElementById('preview-dock-btn').click(); true`);
                    await waitFor(`document.getElementById('preview-pane').parentElement.id === 'agentic-state'`, 'the dock button returns it to the sidebar');
                } else await ev(`document.getElementById('preview-full-back').click(); true`);
            } catch (e) { errors.push(name + ': ' + e.message); }
        }
        assert.deepEqual(errors, []);
    } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
