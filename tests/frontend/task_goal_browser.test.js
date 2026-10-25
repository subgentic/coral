// A task names its goal (#7253, UI/UX's #7249 findings 2 and 6): the Create Task and Edit dialogs have a Goal select listing the board's open goals, a task's detail has a Goal line that opens
// the goal on the Goals face, a Tasks row has a quiet goal chip, and a board that requires a goal has no empty choice (the select says "Choose a goal", and Create refuses without one).
// Real board over the API. Drives Chrome over CDP against the isolated dev server; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'task-goal-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const taskOf = async id => (await api('GET', `/api/board/${B}/tasks/${id}`)).json;
    const shown = id => ev(`getComputedStyle(document.getElementById('${id}')).display !== 'none'`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const [id, t] of [['Boss', 'Orchestrator'], ['dev-1', 'Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' })).status, 200);
        const goal = async (title, state) => { const r = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, ...(state ? { state } : {}) }); assert.equal(r.status, 201, JSON.stringify(r)); return r.json.id; };
        const g1 = await goal('Ship the new installer'), g2 = await goal('Fix the flaky suites');
        const t1 = (await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title: 'Build the installer', priority: 'high', goal_id: g1 })); assert.equal(t1.status, 201, JSON.stringify(t1));
        const t2 = (await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title: 'Write the docs', priority: 'low' })); assert.equal(t2.status, 201);
        await Page.navigate({ url: `${BASE}/board/${B}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message, #mb-messages .mb-queue-run').length >= 1`, 'the board', 15000);
        await ev(`(() => { if (document.getElementById('agentic-state').getBoundingClientRect().width < 50) document.getElementById('panel-toggle-btn').click(); document.getElementById('agentic-tab-tasks').click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item').length >= 2 && document.getElementById('agentic-panel-tasks').getBoundingClientRect().width > 50`, 'the tasks', 15000);

        console.log('1. a Tasks row names its goal in a quiet chip; a task with no goal has none');
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-goal').length === 1`, 'the goal chip', 8000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#agentic-panel-tasks .board-task-item')].map(r => [r.querySelector('.board-task-desc').textContent.trim(), (r.querySelector('.board-task-goal') || {}).textContent || ''])`),
            await ev(`[...document.querySelectorAll('#agentic-panel-tasks .board-task-item')].map(r => [r.querySelector('.board-task-desc').textContent.trim(), /installer/.test(r.querySelector('.board-task-desc').textContent) ? 'Goal: Ship the new installer' : ''])`));
        assert.equal(await ev(`document.querySelector('#agentic-panel-tasks .board-task-goal').textContent`), 'Goal: Ship the new installer', 'the chip says Goal: to a screen reader (hidden words), then the title (#7313)');
        assert.equal(await ev(`document.querySelector('#agentic-panel-tasks .board-task-goal .sr-only').textContent`), 'Goal: ');

        console.log('2. Create Task: the Goal select lists the open goals; the task is made under the chosen one');
        await ev(`document.querySelector('.btn-create-task').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display !== 'none' && !document.getElementById('create-task-goal-row').hidden`, 'the dialog with its Goal select', 8000);
        assert.deepEqual(await ev(`[...document.getElementById('create-task-goal').options].map(o => o.textContent)`), ['No goal', 'Fix the flaky suites', 'Ship the new installer']); // newest activity first, as the Goals view lists them
        await ev(`document.getElementById('create-task-title').value = 'Stabilise CI'; document.getElementById('create-task-goal').value = '${g2}'; document.querySelector('#create-task-modal [data-on-click="m-submit-create-task"]').click(); true`);
        await waitFor(`!document.getElementById('create-task-modal') || getComputedStyle(document.getElementById('create-task-modal')).display === 'none'`, 'the dialog to close', 8000);
        const made = (await api('GET', `/api/board/${B}/tasks?limit=50`)).json;
        const mine = (made.tasks || made).find(t => t.title === 'Stabilise CI');
        assert.equal(mine && mine.goal_id, g2, 'the new task works toward the chosen goal: ' + JSON.stringify(mine));

        console.log('3. a task\'s detail has a Goal line that names the goal and opens it on the Goals face');
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item').length >= 3`, 'the new row', 8000);
        await ev(`[...document.querySelectorAll('#agentic-panel-tasks .board-task-item')].find(r => /Build the installer/.test(r.textContent)).querySelector('.board-task-open').click(); true`);
        await waitFor(`!!document.getElementById('task-detail-goal-open') && document.getElementById('task-detail-goal-open').textContent === 'Ship the new installer'`, 'the Goal line to name its goal', 8000);
        assert.equal(await ev(`document.getElementById('task-detail-goal-open').getAttribute('aria-label')`), 'Open the goal: Ship the new installer');
        await ev(`document.getElementById('task-detail-goal-open').click(); true`);
        await waitFor(`!!document.querySelector('#mb-goals .goals-detail-title') && document.querySelector('#mb-goals .goals-detail-title').textContent === 'Ship the new installer'`, 'the goal to open on the Goals face', 10000);
        assert.equal(await shown('task-detail-modal'), false, 'the task dialog closed');
        await ev(`window.showTaskDetailModal(${t1.json.id}); true`);
        await waitFor(`!!document.getElementById('task-detail-goal-open')`, 'the Goal line again', 8000);
        // The Goals face redraws while this dialog is open (a read that found a change, or the tasks arriving late on a slow runner): the goal's heading is a new element when the dialog closes.
        assert.equal((await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title: 'Arrives while the dialog is open', priority: 'low', goal_id: g1 })).status, 201);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'goals_view.js'); const before = document.getElementById('goals-detail-title'); await m.loadGoals(); window.__redrawn = before !== document.getElementById('goals-detail-title'); return true; })()`);
        assert.equal(await ev(`window.__redrawn`), true, 'the redraw replaced the goal\'s heading while the task dialog was open');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        assert.ok(await ev(`document.getElementById('task-detail-goal-open').getBoundingClientRect().height >= 44`), 'the Goal line button is a 44 px target on a phone (#7313)');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await ev(`window.hideTaskDetailModal(); true`);
        assert.equal(await ev(`document.activeElement.id`), 'goals-detail', 'focus is on the goal\'s detail');

        console.log('4. Edit: the Goal select moves the task to another goal and back to none');
        await ev(`localStorage.setItem('coral.board.face', 'messages'); true`);
        await ev(`(async () => { const m = await import('/static/message_board.js').catch(() => null); return true; })()`);
        await ev(`window.showTaskDetailModal(${t2.json.id}); true`);
        await waitFor(`!!document.querySelector('#task-detail-content [data-on-click="task-edit"], #task-detail-modal-footer [data-on-click="task-edit"]')`, 'Edit', 8000);
        await ev(`document.querySelector('#task-detail-modal-footer [data-on-click="task-edit"]').click(); true`);
        await waitFor(`!!document.getElementById('task-edit-goal') && document.getElementById('task-edit-goal').options.length === 3`, 'the Goal select in Edit', 8000);
        assert.equal(await ev(`document.getElementById('task-edit-goal').value`), '', 'a task with no goal starts on No goal');
        await ev(`document.getElementById('task-edit-goal').value = '${g1}'; document.querySelector('#task-detail-modal-footer [data-on-click="task-edit-save"]').click(); true`);
        await waitFor(`true`, 'a beat', 10);
        for (let n = 0; n < 40 && (await taskOf(t2.json.id)).goal_id !== g1; n++) await ev(`new Promise(r => setTimeout(r, 150))`); // sleep-ok: the save goes over the network
        assert.equal((await taskOf(t2.json.id)).goal_id, g1, 'Save moved the task to the chosen goal');

        console.log('5. a board that requires a goal: the empty choice says "Choose a goal" and Create refuses without one');
        assert.equal((await api('PUT', `/api/board/${B}/settings`, { subscriber_id: 'Operator', require_goal: true })).status, 200);
        await ev(`document.querySelector('.btn-create-task').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display !== 'none' && !document.getElementById('create-task-goal-row').hidden && document.getElementById('create-task-goal').options[0].textContent === 'Choose a goal'`, 'the required Goal select', 8000);
        await ev(`document.getElementById('create-task-title').value = 'No goal here'; document.querySelector('#create-task-modal [data-on-click="m-submit-create-task"]').click(); true`);
        await waitFor(`/Choose a goal/.test(document.getElementById('create-task-goal-error').textContent) && !document.getElementById('create-task-goal-error').hidden`, 'the refusal beside the select', 6000);
        assert.deepEqual(await ev(`(() => { const sel = document.getElementById('create-task-goal'), line = document.getElementById('create-task-goal-error'); return { required: sel.required, ariaRequired: sel.getAttribute('aria-required'), invalid: sel.getAttribute('aria-invalid'), by: sel.getAttribute('aria-describedby'), role: line.getAttribute('role'), beside: sel.closest('label').nextElementSibling === line, focus: document.activeElement.id }; })()`),
            { required: true, ariaRequired: 'true', invalid: 'true', by: 'create-task-goal-error', role: 'alert', beside: true, focus: 'create-task-goal' }, 'the select is required, marked invalid and described by the refusal beside it (#7313)');
        await ev(`const sel = document.getElementById('create-task-goal'); sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); true`);
        assert.equal(await ev(`document.getElementById('create-task-goal').getAttribute('aria-invalid') + ':' + document.getElementById('create-task-goal-error').hidden`), 'null:true', 'choosing a goal takes the refusal away');
        // at 390 px and 200% text the refusal is scrolled into view, not left behind the dialog's footer (#7313)
        await ev(`document.getElementById('create-task-goal').value = ''; true`);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
        await ev(`document.documentElement.style.fontSize = '32px'; document.querySelector('#create-task-modal [data-on-click="m-submit-create-task"]').click(); true`);
        await waitFor(`!document.getElementById('create-task-goal-error').hidden`, 'the refusal at large text', 6000);
        await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: the scroll settles
        const seen = await ev(`(() => { const r = document.getElementById('create-task-goal-error').getBoundingClientRect(), f = document.querySelector('#create-task-modal .modal-footer, #create-task-modal .modal-actions, #create-task-modal [data-on-click="m-submit-create-task"]').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, footerTop: Math.round(f.top) }; })()`);
        assert.ok(seen.top >= 0 && seen.bottom <= seen.vh, `the refusal is on the screen: ${JSON.stringify(seen)}`);
        await ev(`document.documentElement.style.fontSize = ''; true`); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        assert.equal(((await api('GET', `/api/board/${B}/tasks?limit=50`)).json.tasks || []).some(t => t.title === 'No goal here'), false, 'nothing was created');
        console.log('6. Team settings has the Require a goal switch with its one sentence; Save writes it');
        assert.equal((await api('PUT', `/api/board/${B}/settings`, { subscriber_id: 'Operator', require_goal: false })).status, 200);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_working_mode.js'); await m.showTeamWorkingMode(${JSON.stringify(B)}, { workspace: true }); return true; })()`);
        await waitFor(`!!document.querySelector('input[name="require_goal"]') && document.querySelector('input[name="require_goal"]').closest('label').textContent.trim() === 'Require a goal'`, 'the switch', 10000);
        await waitFor(`document.querySelector('input[name="require_goal"]').closest('form').dataset.initialState !== undefined`, 'the settings to finish loading', 10000);
        assert.equal(await ev(`document.getElementById('require-goal-hint').textContent`), 'Every new task needs a goal, and a task cannot be moved to no goal.');
        assert.equal(await ev(`document.querySelector('input[name="require_goal"]').getAttribute('aria-describedby')`), 'require-goal-hint');
        assert.equal(await ev(`document.querySelector('input[name="require_goal"]').checked`), false);
        await ev(`const sw = document.querySelector('input[name="require_goal"]'); sw.click(); document.querySelector('form [type=submit]').click(); true`);
        for (let n = 0; n < 40 && !(await api('GET', `/api/board/${B}/settings`)).json.require_goal; n++) await ev(`new Promise(r => setTimeout(r, 150))`); // sleep-ok: the save goes over the network
        assert.equal((await api('GET', `/api/board/${B}/settings`)).json.require_goal, true, 'Save turned the rule on');
        console.log('PASS a task names its goal');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
