// A task names its goal (#7253, UI/UX's #7249 findings 2 and 6; the task's page since #7644): the Create Task dialog and the task page's Edit have a Goal select listing the board's open goals, a task's page has a Goal line that opens
// the goal on the team page's Goals tab, a Tasks row has a quiet goal chip, and a board that requires a goal has no empty choice (the select says "Choose a goal", and Create refuses without one).
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
        // the board's Tasks tab is an agent's on that board (the board's page has no side panel, #7457)
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('goal-agent', 'G', 1, { sleeping: false, board_project: ${JSON.stringify(B)} }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'goal-agent')`, 'the agent', 8000);
        await ev(`window.selectLiveSession('goal-agent', 'claude', 'goal-agent-id', 'local'); true`);
        await ev(`(() => { if (document.getElementById('agentic-state').getBoundingClientRect().width < 50) document.getElementById('panel-toggle-btn').click(); document.getElementById('agentic-tab-tasks').click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item').length >= 2 && document.getElementById('agentic-panel-tasks').getBoundingClientRect().width > 50`, 'the tasks', 15000);

        console.log('1. a dock Tasks row is one line (#8792): no goal chip on it; the goal is on the task\'s own detail (step 3)');
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item').length === 2`, 'the two rows', 8000);
        assert.equal(await ev(`document.querySelectorAll('#agentic-panel-tasks .dt-subtitle').length`), 0, 'no secondary line on a row: the status, the title and who');

        console.log('2. Create Task: the Goal select lists the open goals; the task is made under the chosen one');
        await ev(`document.querySelector('#board-task-bar .btn-create-task').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display !== 'none' && !document.getElementById('create-task-goal').closest('.sv-row').hidden`, 'the dialog with its Goal select', 8000);
        assert.deepEqual(await ev(`[...document.getElementById('create-task-goal').options].map(o => o.textContent)`), ['No goal', 'Fix the flaky suites', 'Ship the new installer']); // newest activity first, as the Goals view lists them
        await ev(`document.getElementById('create-task-title').value = 'Stabilise CI'; document.getElementById('create-task-goal').value = '${g2}'; document.getElementById('create-task-submit').click(); true`);
        await waitFor(`!document.getElementById('create-task-modal') || getComputedStyle(document.getElementById('create-task-modal')).display === 'none'`, 'the dialog to close', 8000);
        const made = (await api('GET', `/api/board/${B}/tasks?limit=50`)).json;
        const mine = (made.tasks || made).find(t => t.title === 'Stabilise CI');
        assert.equal(mine && mine.goal_id, g2, 'the new task works toward the chosen goal: ' + JSON.stringify(mine));

        console.log('3. a task\'s page has a Goal line that names the goal and opens it on the Goals tab');
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item').length >= 3`, 'the new row', 8000);
        await ev(`[...document.querySelectorAll('#agentic-panel-tasks .board-task-item')].find(r => /Build the installer/.test(r.textContent)).querySelector('.board-task-open').click(); true`);
        await waitFor(`!!document.querySelector('#preview-pane #team-task-title') && !!document.querySelector('#preview-pane .goals-facts button.team-link[data-goal-link], #preview-pane .goals-facts dd button.team-link')`, 'the task page with its Goal line', 12000);
        await waitFor(`[...document.querySelectorAll('#preview-pane .goals-facts dd button.team-link')].some(b => b.textContent === 'Ship the new installer')`, 'the Goal line to name its goal', 8000);
        assert.equal(await shown('task-detail-modal'), false, 'no dialog opened');
        await ev(`[...document.querySelectorAll('#preview-pane .goals-facts dd button.team-link')].find(b => b.textContent === 'Ship the new installer').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .goals-detail-title') && document.querySelector('#team-panel-goals .goals-detail-title').textContent === 'Ship the new installer'`, 'the goal to open on the Goals tab', 10000);

        console.log('4. Edit: the Goal select moves the task to another goal and back to none');
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks', item: ${t2.json.id} }); true`);
        await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && [...document.querySelectorAll('#team-panel-item .goals-pinbar .btn, #team-panel-item .goals-pinbar [role=menuitem]')].some(b => b.textContent === 'Edit')`, 'Edit', 12000);
        await ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn, #team-panel-item .goals-pinbar [role=menuitem]')].find(b => b.textContent === 'Edit').click(); true`);
        await waitFor(`!!document.getElementById('task-edit-goal') && document.getElementById('task-edit-goal').options.length === 3`, 'the Goal select in Edit', 8000);
        assert.equal(await ev(`document.getElementById('task-edit-goal').value`), '', 'a task with no goal starts on No goal');
        await ev(`document.getElementById('task-edit-goal').value = '${g1}'; [...document.querySelectorAll('#team-panel-item .goals-pinbar .btn, #team-panel-item .goals-pinbar [role=menuitem]')].find(b => b.textContent === 'Save').click(); true`);
        for (let n = 0; n < 40 && (await taskOf(t2.json.id)).goal_id !== g1; n++) await ev(`new Promise(r => setTimeout(r, 150))`); // sleep-ok: the save goes over the network
        assert.equal((await taskOf(t2.json.id)).goal_id, g1, 'Save moved the task to the chosen goal');
        await waitFor(`!document.getElementById('task-edit-goal') && [...document.querySelectorAll('#team-panel-item .goals-facts dd button.team-link')].some(b => b.textContent === 'Ship the new installer')`, 'the page naming the new goal', 8000);
        await ev(`window.exitTeamPage && window.exitTeamPage({ force: true }); window.selectLiveSession('goal-agent', 'claude', 'goal-agent-id', 'local'); true`);
        await waitFor(`!!document.querySelector('#board-task-bar .btn-create-task') && document.querySelector('#board-task-bar .btn-create-task').getClientRects().length > 0`, 'the Tasks tab again', 8000);

        console.log('5. a board that requires a goal: the empty choice says "Choose a goal" and Create refuses without one');
        assert.equal((await api('PUT', `/api/board/${B}/settings`, { subscriber_id: 'Operator', require_goal: true })).status, 200);
        await ev(`document.querySelector('#board-task-bar .btn-create-task').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display !== 'none' && !document.getElementById('create-task-goal').closest('.sv-row').hidden && document.getElementById('create-task-goal').options[0].textContent === 'Choose a goal'`, 'the required Goal select', 8000);
        await ev(`document.getElementById('create-task-title').value = 'No goal here'; document.getElementById('create-task-submit').click(); true`);
        await waitFor(`/Choose a goal/.test(document.getElementById('create-task-goal').closest('.sv-row').querySelector('.sv-error').textContent) && !document.getElementById('create-task-goal').closest('.sv-row').querySelector('.sv-error').hidden`, 'the refusal beside the select', 6000);
        assert.deepEqual(await ev(`(() => { const sel = document.getElementById('create-task-goal'), line = document.getElementById('create-task-goal').closest('.sv-row').querySelector('.sv-error'); return { required: sel.required, ariaRequired: sel.getAttribute('aria-required'), invalid: sel.getAttribute('aria-invalid'), by: (sel.getAttribute('aria-describedby') || '').split(' ').includes(line.id) ? 'create-task-goal-error' : sel.getAttribute('aria-describedby'), role: line.getAttribute('role'), beside: sel.closest('.sv-row').contains(line), focus: document.activeElement.id }; })()`),
            { required: true, ariaRequired: 'true', invalid: 'true', by: 'create-task-goal-error', role: null, beside: true, focus: 'create-task-goal' }, 'the select is required, marked invalid and described by the refusal beside it (#7313)');
        await ev(`const sel = document.getElementById('create-task-goal'); sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); true`);
        assert.equal(await ev(`document.getElementById('create-task-goal').getAttribute('aria-invalid') + ':' + document.getElementById('create-task-goal').closest('.sv-row').querySelector('.sv-error').hidden`), 'null:true', 'choosing a goal takes the refusal away');
        // at 390 px and 200% text the refusal is scrolled into view, not left behind the dialog's footer (#7313)
        await ev(`document.getElementById('create-task-goal').value = ''; true`);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
        await ev(`document.documentElement.style.fontSize = '32px'; document.getElementById('create-task-submit').click(); true`);
        await waitFor(`!document.getElementById('create-task-goal').closest('.sv-row').querySelector('.sv-error').hidden`, 'the refusal at large text', 6000);
        await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: the scroll settles
        const seen = await ev(`(() => { const r = document.getElementById('create-task-goal').closest('.sv-row').querySelector('.sv-error').getBoundingClientRect(), f = document.querySelector('#create-task-modal .modal-footer, #create-task-modal .modal-actions, #create-task-submit').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, footerTop: Math.round(f.top) }; })()`);
        assert.ok(seen.top >= 0 && seen.bottom <= seen.vh, `the refusal is on the screen: ${JSON.stringify(seen)}`);
        await ev(`document.documentElement.style.fontSize = ''; true`); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        assert.equal(((await api('GET', `/api/board/${B}/tasks?limit=50`)).json.tasks || []).some(t => t.title === 'No goal here'), false, 'nothing was created');
        console.log('6. Team settings has the Require a goal switch with its one sentence; Save writes it');
        assert.equal((await api('PUT', `/api/board/${B}/settings`, { subscriber_id: 'Operator', require_goal: false })).status, 200);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_working_mode.js'); await m.showTeamWorkingMode(${JSON.stringify(B)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) }); return true; })()`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv-row[data-key="require_goal"] .sv-label') && document.querySelector('#team-settings-workspace .sv-row[data-key="require_goal"] .sv-label').textContent.trim() === 'Require a goal'`, 'the switch', 10000);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the settings to finish loading', 10000);
        assert.equal(await ev(`document.querySelector('#team-settings-workspace .sv-row[data-key="require_goal"] .sv-help-text').textContent`), 'Every new task needs a goal, and a task cannot be moved to no goal.');
        assert.equal(await ev(`document.getElementById(document.querySelector('input[name="require_goal"]').getAttribute('aria-describedby').split(' ')[0]).textContent`), 'Every new task needs a goal, and a task cannot be moved to no goal.', 'the switch is described by that sentence');
        assert.equal(await ev(`document.querySelector('input[name="require_goal"]').checked`), false);
        await ev(`const sw = document.querySelector('input[name="require_goal"]'); sw.click(); document.querySelector('#team-settings-workspace .sv-save').click(); true`);
        for (let n = 0; n < 40 && !(await api('GET', `/api/board/${B}/settings`)).json.require_goal; n++) await ev(`new Promise(r => setTimeout(r, 150))`); // sleep-ok: the save goes over the network
        assert.equal((await api('GET', `/api/board/${B}/settings`)).json.require_goal, true, 'Save turned the rule on');
        console.log('PASS a task names its goal');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
