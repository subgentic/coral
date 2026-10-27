// #8905: preview tabs retain a visible title, and a task's column never squeezes chat below 420px.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { framesJs } = require('./helpers/wait');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const board = 'preview-room-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const api = (p, b) => fetch('/api/board/${board}' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => { if (!r.ok) throw new Error('fixture ' + r.status); });
            await api('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' });
            for (const title of ['First task with a descriptive title', 'Second task with a descriptive title']) await api('/tasks', { subscriber_id: 'Boss', title, body: 'Readable task preview', assigned_to: 'Boss' });
        })()`);
        await openBoardTasksTab({ ev, waitFor }, board);
        await waitFor(`document.querySelectorAll('#board-task-list .board-task-open').length === 2`, 'two tasks');
        await ev(`[...document.querySelectorAll('#board-task-list .board-task-open')].find(b => b.textContent.startsWith('First task')).click(); true`);
        await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`, 'first preview');
        await ev(`document.querySelector('#preview-pane .preview-tab-keep').click(); [...document.querySelectorAll('#board-task-list .board-task-open')].find(b => b.textContent.startsWith('Second task')).click(); true`);
        await waitFor(`document.querySelectorAll('#preview-tabs .preview-tab').length === 2 && document.querySelector('#preview-pane #team-task-title')?.textContent.includes('Second task')`, 'second preview');
        // Select the full-height preference explicitly, as in the reported screenshot.
        await ev(`document.getElementById('preview-dock-btn').click(); true`);
        await ev(framesJs(2));
        const narrow = await ev(`({ parent: document.getElementById('preview-pane').parentElement.id, chat: document.querySelector('.live-left-column').getBoundingClientRect().width })`);
        if (narrow.parent !== 'agentic-state' || narrow.chat < 420) failures.push('1280 must fall back to sidebar with chat >=420: ' + JSON.stringify(narrow));
        for (const width of [1920, 1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await ev(framesJs(2));
            if (width === 390) {
                await ev(`window.toggleAgenticPanel(true); window.switchAgenticTab('tasks', 'top'); true`);
                await waitFor(`document.querySelector('#board-task-list .board-task-open')?.getClientRects().length > 0`, 'phone Tasks panel');
                await ev(`[...document.querySelectorAll('#board-task-list .board-task-open')].find(b => b.textContent.startsWith('Second task')).click(); true`);
                await waitFor(`document.getElementById('preview-pane').classList.contains('preview-phone-full') && document.querySelector('#preview-pane #team-task-title')?.textContent.includes('Second task')`, 'phone task preview is open');
            }
            const seen = await ev(`(() => { const bar = document.getElementById('preview-tabs'), b = bar.getBoundingClientRect(), tab = bar.querySelector('.preview-tab.active'), t = tab.querySelector('.preview-tab-name'), r = t.getBoundingClientRect(); return { text: t.textContent, titleWidth: r.width, visibleWidth: Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)), parent: document.getElementById('preview-pane').parentElement.id, chat: document.querySelector('.live-left-column').getBoundingClientRect().width }; })()`);
            if (!seen.text.includes('Second task') || seen.titleWidth < 50 || seen.visibleWidth < 50) failures.push(width + ': active tab title must remain readable: ' + JSON.stringify(seen));
            if (width === 1920 && (seen.parent !== 'preview-column' || seen.chat < 420)) failures.push('wide screen retains column preference: ' + JSON.stringify(seen));
            if (width === 1280 && seen.parent !== 'agentic-state') failures.push('shrinking returns task to bottom: ' + JSON.stringify(seen));
            const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
            if (dir) { fs.mkdirSync(dir, { recursive: true }); for (const theme of ['dark', 'light']) { await setTheme(ev, theme); fs.writeFileSync(path.join(dir, `task-preview-room-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
        }
        assert.deepEqual(failures, []);
    } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
