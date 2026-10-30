// Closing the agent dock's task preview gives the focus back to the row that opened it, at 1280 as at 390 (#8830 item 1, from the #8829 walk): Escape on the preview's heading and Enter on its Close button.
// Real isolated board; drives Chrome over CDP against the dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const board = 'preview-focus-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect(); const Input = client.Input;
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const key = async (k, code, vk, extra = {}) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...extra }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); await settle(150); };
    const enter = () => key('Enter', 'Enter', 13, { text: '\r', unmodifiedText: '\r' });
    const escape = () => key('Escape', 'Escape', 27);
    const api = (m, p, b) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(b))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const rowKey = () => ev(`(document.activeElement.closest('tr') || { dataset: {} }).dataset.key || document.activeElement.tagName`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' });
        for (let i = 1; i <= 4; i++) assert.equal((await api('POST', `/api/board/${board}/tasks`, { subscriber_id: 'Boss', title: 'Focus task ' + i, body: 'Description ' + i, priority: 'medium', assigned_to: 'Boss' })).status, 201);
        for (const [tag, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'liveListLoaded', 'settings');
            await openBoardTasksTab({ ev, waitFor }, board);
            await waitFor(`document.querySelectorAll('#board-task-list .board-task-item').length >= 3`, 'the task list', 10000); await settle(300);
            const open = async () => { await ev(`document.querySelectorAll('#board-task-list .board-task-name')[1].focus(); true`); const k = await rowKey(); await enter(); await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`, 'the preview', 8000); await settle(300); return k; };
            let k = await open();
            await ev(`document.querySelector('#preview-pane h2').focus(); true`); await escape();
            await waitFor(`!document.querySelector('#preview-pane .team-task-page')`, 'the preview to close', 6000);
            assert.equal(await rowKey(), k, `${tag}: Escape on the heading gives the focus back to the row that opened the preview`);
            k = await open();
            await ev(`document.querySelector('#preview-pane .preview-tab-close').focus(); true`); await enter();
            await waitFor(`!document.querySelector('#preview-pane .team-task-page')`, 'the preview to close', 6000);
            assert.equal(await rowKey(), k, `${tag}: Close gives the focus back to the row that opened the preview`);
            console.log('PASS ' + tag);
        }
    } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
