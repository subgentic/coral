// UI/UX's 170 list, items 9 and 12 (task 7639). Item 9: the labels of the Restart dialog's permission mode and of the Add Macro dialog (Label, Command) have no colon, as nowhere else. Item 12: the agent dock's
// Tasks table uses the shared header typography, a board task's name is the row's one real button (its id is text), and a mouse click on a row leaves no focus ring behind. The task
// list is an agent's Tasks tab on a real board of the isolated dev server (helpers/board_tasks_tab.js). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const SHOT_DIR = process.env.CORAL_SCREENSHOT_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'out', 'shots');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme } = require('./helpers/contrast');

const B = 'dock-tasks-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
        for (const [id, t] of [['Boss', 'Orchestrator'], ['dev-1', 'Developer']]) assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' }), 200);
        for (const [title, priority] of [['Ship the queue', 'high'], ['Write the docs', 'low'], ['Fix the focus ring', 'medium']]) assert.equal(await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title, priority }), 201);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await openBoardTasksTab({ ev, waitFor }, B);
        await waitFor(`document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length === 3 && document.getElementById('agentic-panel-tasks').getBoundingClientRect().width > 50`, 'three task rows', 15000);

        for (const width of [420, 680, 980]) {
            await ev(`(() => { const d = document.getElementById('agentic-state'); d.style.transition = 'none'; d.style.width = '${width}px'; return d.offsetWidth; })()`);
            // #7800: the same columns must start at the same edge, regardless of header/row element types.
            await waitFor(`document.querySelector('#board-task-list .dt-box').classList.contains('dt-folded') === false`, 'responsive table layout');
            const edges = await ev(`(() => {
                const head = document.querySelector('#board-task-list thead tr');
                const rows = [...document.querySelectorAll('#board-task-list tbody tr')];
                return [...head.cells].map((h, i) => ({ col: h.textContent, visible: !!h.getClientRects().length,
                    head: h.getBoundingClientRect().left, rows: rows.map(r => r.cells[i].getBoundingClientRect().left) }));
            })()`);
            for (const col of edges.filter(c => c.visible)) for (const left of col.rows)
                assert.ok(Math.abs(left - col.head) < 1, `${col.col}: header ${col.head}, cell ${left}`);

            if (SHOT_DIR) {
                for (const theme of ['dark', 'light']) {
                    await setTheme(ev, theme);
                    fs.writeFileSync(path.join(SHOT_DIR, 'dock-tasks-' + width + '-' + theme + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
                }
                await setTheme(ev, 'dark');
            }
        }
        await ev(`document.getElementById('agentic-state').style.width = '420px'; true`);

        console.log('12. a shared table head, the name is the one button, no ring after a click');
        if (SHOT_DIR) fs.writeFileSync(path.join(SHOT_DIR, 'dock-tasks.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        const head = await ev(`(() => { const h = document.querySelector('#board-task-list thead tr'); const cs = getComputedStyle(h.cells[0]); return { texts: [...h.children].map(c => c.textContent.replace(/[↕↑↓]/g, '').trim()), transform: cs.textTransform, weight: cs.fontWeight, size: cs.fontSize }; })()`);
        assert.equal(head.transform, 'uppercase', 'the head uses shared typography: ' + JSON.stringify(head));
        assert.deepEqual([head.weight, head.size], ['600', '11px'], 'shared header typography');
        assert.deepEqual(head.texts, ['State', 'Task', 'Who'], 'the words as written: the dock shows State, Task and Assigned to only (#7962, #8060)');
        const row = await ev(`(() => { const r = document.querySelector('#board-task-list .board-task-item:not(.board-task-header)'); const b = [...r.querySelectorAll('button')]; return { buttons: b.length, name: b[0] && b[0].getAttribute('aria-label'), inDesc: !!(b[0] && b[0].closest('.board-task-desc')), idIsButton: !!r.querySelector('button.board-task-id') }; })()`);
        assert.equal(row.buttons, 1, 'one real button on the row: ' + JSON.stringify(row)); assert.ok(row.inDesc && !row.idIsButton, 'the name is the only row action');
        assert.ok(/^Open task: [A-Z]/.test(row.name), 'its name says what it opens: ' + row.name);
        const mouse = async sel => { const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: r.x, y: r.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); }; // a real mouse: the page's last input is the pointer (a scripted click() sets no input modality)
        await mouse('#board-task-list .board-task-item:not(.board-task-header) .board-task-desc');
        await waitFor(`!!document.querySelector('#preview-pane #team-task-title') && document.getElementById('task-detail-modal') && getComputedStyle(document.getElementById('task-detail-modal')).display === 'none'`, 'the task opens in the shared preview pane (#8788)', 12000);
        await mouse('#preview-pane .preview-tab-close');
        await waitFor(`document.querySelectorAll('#board-task-list .board-task-item').length > 0 && document.getElementById('board-task-list').getClientRects().length > 0`, 'the dock\'s list again', 8000);
        const ring = await ev(`[...document.querySelectorAll('#board-task-list *')].filter(e => { const c = getComputedStyle(e); return c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0; }).map(e => e.className)`);
        assert.deepEqual(ring, [], 'no element of the list wears a ring after a mouse click and the page being left');

        console.log('9. no colons on the Restart and Add Macro labels (Restart: the Permission mode is a settings_view row since #8462, so its label is the row label)');
        await ev(`import((window.__coralStatic || '/static/') + 'controls.js').then(m => { m.showMacroModal(); return true; })`); // the form is drawn when the dialog opens
        const macro = await ev(`['macro-label-input', 'macro-command-input'].map(id => document.querySelector('label[for="' + id + '"]').textContent.trim())`);
        assert.deepEqual(macro, ['Label', 'Command'], 'the Add Macro labels');
        await ev(`window.selectLiveSession && true; window.restartSession(); true`);
        await waitFor(`!!document.querySelector('#restart-acf .acf-permission-mode')`, 'the Restart form', 10000);
        const restart = await ev(`document.querySelector('#restart-acf .acf-permission-mode').closest('.sv-row').querySelector('.sv-label').textContent.trim()`);
        assert.equal(restart, 'Permission mode', 'the Restart label');
        console.log('PASS dock tasks and labels');
    } finally { await removeBoards(ev, [B]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
