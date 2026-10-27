// A task's actions are on its page (#7644): Edit, Complete, Cancel, Publish, Nudge, Remind and the dependencies were the task dialog's. Against a real board on the isolated dev server (the board is removed again):
// the pinned bar has the buttons the task's state allows (an open task: the danger Cancel task first, then Edit, Nudge, Remind, Stop reminders and Complete last; a draft: Publish, no Complete; a finished one: none); Edit turns the page into its
// form (Save and Cancel in the bar), changes the title and priority, needs a reason for a changed description and writes it, and keeps what the person typed on a refusal; Complete asks for a message and the required outputs
// and finishes the task; Cancel asks in the bar ("Keep task" returns, "Cancel task" cancels); a dependency is chosen in the form and shows under "Blocked by"; the dock's task name opens the page, not the dialog.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'tpa-' + Date.now().toString(36);
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); new Promise(r => setTimeout(r, 350))`); /* sleep-ok: a screenshot waits out transitions; the toasts of the steps before are not the picture */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const barButtons = () => ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].map(b => b.textContent)`);
    const open = async (id) => { await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks', item: ${id} }); true`); await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && document.querySelector('#team-task-title').textContent.startsWith('#${id} ')`, 'the task page', 12000); await waitFor(`document.querySelectorAll('#team-panel-item .goals-pinbar .btn').length >= 0 && !!document.querySelector('#team-panel-item .goals-pinbar')`, 'the bar'); };
    const click = (text) => ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].find(b => b.textContent === ${JSON.stringify(text)}).click(); true`);
    const set = (id, value) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const task = async (id) => (await api('GET', `/api/board/${B}/tasks/${id}`)).body;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [id, jt] of [['orch', 'Orchestrator'], ['fe', 'Frontend Dev'], ['qa', 'QA Engineer'], ['be', 'Backend Dev']]) await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' });
        const mk = async (extra) => { const r = await api('POST', `/api/board/${B}/tasks`, { body: 'Details', created_by: 'orch', priority: 'medium', ...extra }); assert.ok(r.status < 300, JSON.stringify(r)); return r.body.id || r.body.task.id; };
        const open1 = await mk({ title: 'Build the page', assigned_to: 'fe' });
        const dep = await mk({ title: 'The step before' });
        const draft = await mk({ title: 'A draft task', draft: true });
        const finish = await mk({ title: 'Finish me', assigned_to: 'qa' });
        const doomed = await mk({ title: 'Cancel me' });
        const needs = await mk({ title: 'Needs outputs', assigned_to: 'be', workflow: { required_outputs: ['report'] } });
        const done = await mk({ title: 'Already done', assigned_to: 'orch' });
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'fe', task_id: open1 })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'orch', task_id: done })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${done}/complete`, { subscriber_id: 'orch', message: 'Done.' })).status, 200);

        console.log('1. The bar holds what the state allows');
        await open(open1);
        await shot('task-page-view');
        const bar = await barButtons();
        check('an open task: the danger Cancel task first, alone at the left, then Edit, Nudge, Remind, Stop reminders, and Complete last (the one pinned-bar rule, #7684)', bar[0] === 'Cancel task' && bar[bar.length - 1] === 'Complete' && ['Edit', 'Nudge', 'Remind', 'Stop reminders', 'Complete'].every(t => bar.includes(t)), JSON.stringify(bar));
        check('Cancel task is a danger button', await ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].find(b => b.textContent === 'Cancel task').classList.contains('btn-danger')`));
        await open(draft);
        const dbar = await barButtons();
        check('a draft: Publish, no Complete', dbar.includes('Publish') && !dbar.includes('Complete') && dbar.includes('Edit'), JSON.stringify(dbar));
        await open(done);
        check('a finished task: no actions', (await barButtons()).every(t => !['Edit', 'Complete', 'Cancel task', 'Publish', 'Nudge'].includes(t)), JSON.stringify(await barButtons()));

        console.log('2. Edit');
        await open(open1);
        await click('Edit');
        await waitFor(`!!document.getElementById('task-edit-title')`, 'the form');
        check('the form has title, description, instructions, reason, priority, assignee', ['task-edit-title', 'task-edit-body', 'task-edit-instructions', 'task-edit-reason', 'task-edit-priority', 'task-edit-assignee'].length === 6 && await ev(`['task-edit-title','task-edit-body','task-edit-instructions','task-edit-reason','task-edit-priority','task-edit-assignee'].every(i => !!document.getElementById(i))`));
        await shot('task-page-edit');
        check('the bar holds Cancel and Save', JSON.stringify(await barButtons()) === JSON.stringify(['Cancel', 'Save']), JSON.stringify(await barButtons()));
        check('the title field has the focus', await ev(`document.activeElement && document.activeElement.id === 'task-edit-title'`));
        await set('task-edit-title', 'Build the task page'); await set('task-edit-priority', 'high');
        await click('Save');
        await waitFor(`document.querySelector('#team-task-title').textContent === '#${open1} Build the task page'`, 'the saved page', 8000);
        const t1 = await task(open1);
        check('the title and priority were written', t1.title === 'Build the task page' && t1.priority === 'high', JSON.stringify([t1.title, t1.priority]));
        await click('Edit'); await waitFor(`!!document.getElementById('task-edit-body')`, 'the form again');
        await set('task-edit-body', 'A new description'); await click('Save');
        await waitFor(`!!document.querySelector('#task-edit-error') && !document.querySelector('#task-edit-error').hidden`, 'the refusal');
        check('a changed description without a reason is refused in words, and the form stays', /amendment reason is required/i.test(await ev(`document.getElementById('task-edit-error').textContent`)) && await ev(`document.getElementById('task-edit-body').value`) === 'A new description');
        await set('task-edit-reason', 'The scope grew'); await click('Save');
        await waitFor(`!document.getElementById('task-edit-body')`, 'the saved page again', 8000);
        const t1b = await task(open1);
        check('the description was amended with its reason', t1b.body === 'A new description' && Number(t1b.revision) > 1, JSON.stringify([t1b.body, t1b.revision]));
        await click('Edit'); await waitFor(`!!document.getElementById('task-edit-title')`, 'the form for Cancel'); await set('task-edit-title', 'Discarded'); await click('Cancel');
        await waitFor(`!document.getElementById('task-edit-title')`, 'back on the page');
        check('Cancel in the form discards the edit', (await task(open1)).title === 'Build the task page');

        console.log('3. Dependencies');
        await open(doomed);
        await click('Edit'); await waitFor(`!!document.querySelector('#task-edit-deps .dep-picker-add-link')`, 'the dependency picker', 8000);
        await ev(`document.querySelector('#task-edit-deps .dep-picker-add-link').click(); true`);
        await ev(`document.querySelector('#task-edit-deps input[type=checkbox][value="${dep}"]').click(); true`);
        check('the chosen dependency shows as a tag that can be removed', await ev(`!!document.querySelector('#task-edit-deps .dep-tag .dep-tag-remove[aria-label^="Remove dependency"]')`));
        await click('Save');
        await waitFor(`!document.getElementById('task-edit-title') && !!document.querySelector('#team-panel-item .task-dep-link')`, 'Blocked by on the page', 8000);
        check('the task waits for it: Blocked by lists it, as a link to its page', (await task(doomed)).blocked_by?.[0]?.task_id === dep && await ev(`!!document.querySelector('#team-panel-item .task-dep-link[data-task-id="${dep}"]')`));

        console.log('4. Cancel asks in the bar');
        await click('Cancel task');
        await waitFor(`!!document.querySelector('#team-panel-item .task-confirm-text')`, 'the question');
        await shot('task-page-cancel');
        check('the question and its two answers', await ev(`document.querySelector('#team-panel-item .task-confirm-text').textContent`) === 'Cancel this task? This cannot be undone.' && await ev(`[...document.querySelectorAll('#team-panel-item .task-confirm-buttons .btn')].map(b => b.textContent).join()`) === 'Keep task,Cancel task');
        check('the safe answer, Keep task, has the focus', await ev(`document.activeElement && document.activeElement.textContent === 'Keep task'`));
        await ev(`[...document.querySelectorAll('#team-panel-item .task-confirm-buttons .btn')].find(b => b.textContent === 'Keep task').click(); true`);
        await waitFor(`!document.querySelector('#team-panel-item .task-confirm-text')`, 'back to the bar');
        check('Keep task returns to the bar and cancels nothing', (await task(doomed)).status !== 'skipped' && (await barButtons()).includes('Cancel task'));
        await click('Cancel task'); await waitFor(`!!document.querySelector('#team-panel-item .task-confirm-text')`, 'the question again');
        await ev(`[...document.querySelectorAll('#team-panel-item .task-confirm-buttons .btn')].find(b => b.textContent === 'Cancel task').click(); true`);
        await waitFor(`!document.querySelector('#team-panel-item .task-confirm-text') && /Cancelled/i.test(document.getElementById('team-panel-item').innerText)`, 'the cancelled task', 8000);
        check('Cancel task in the question cancels it and the page shows it, with no actions left', (await task(doomed)).status === 'skipped' && !(await barButtons()).includes('Cancel task'));

        console.log('5. Complete');
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'qa', task_id: finish })).status, 200);
        await open(finish);
        await click('Complete');
        await waitFor(`!!document.getElementById('task-complete-message')`, 'the completion form');
        await shot('task-page-complete');
        { const { setTheme } = require('./helpers/contrast'); await setTheme(ev, 'light'); await shot('task-page-complete-light'); await setTheme(ev, 'dark'); } // the light theme, by eye too
        check('the form has the message, the outcome and the optional evidence; its message has the focus', await ev(`document.activeElement.id === 'task-complete-message' && !!document.getElementById('task-complete-outcome') && !!document.querySelector('.task-completion-evidence')`));
        check('the bar holds Back and Complete', JSON.stringify(await barButtons()) === JSON.stringify(['Back', 'Complete']), JSON.stringify(await barButtons()));
        await set('task-complete-message', 'Finished from the page'); await click('Complete');
        await waitFor(`!document.getElementById('task-complete-message') && /Finished from the page/.test(document.getElementById('team-panel-item').innerText)`, 'the finished page', 8000);
        const tf = await task(finish);
        check('the task is completed with the message', tf.status === 'completed' && tf.completion_message === 'Finished from the page', JSON.stringify([tf.status, tf.completion_message]));
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: needs })).status, 200);
        await open(needs); await click('Complete'); await waitFor(`!!document.getElementById('task-complete-message')`, 'the form with outputs');
        check('required outputs are named on the form, and the evidence is open', await ev(`[...document.querySelectorAll('.task-completion-required li')].map(l => l.textContent).join() === 'report' && document.querySelector('.task-completion-evidence').open`));
        await click('Complete');
        await waitFor(`!document.getElementById('task-complete-error').hidden`, 'the refusal');
        check('completing without the output is refused in words and the form stays', /Required outputs missing: report/.test(await ev(`document.getElementById('task-complete-error').textContent`)) && (await task(needs)).status !== 'completed');
        await set('task-artifact-name', 'report'); await set('task-artifact-content', 'All green'); await click('Complete');
        await waitFor(`!document.getElementById('task-complete-message')`, 'the finished page', 8000);
        check('with the named output the task completes', (await task(needs)).status === 'completed');

        console.log('6. Publish');
        await open(draft); await click('Publish');
        await waitFor(`![...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].some(b => b.textContent === 'Publish')`, 'published', 8000);
        check('Publish makes the draft a task', (await task(draft)).status !== 'draft', (await task(draft)).status);

        console.log('6b. On a phone the bar wraps and nothing is wider than the screen');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await open(open1); await shot('task-page-view-phone');
        const wide = () => ev(`document.documentElement.scrollWidth - innerWidth`);
        check('the page fits the phone', await wide() <= 0, String(await wide()));
        check('the bar buttons are 44 px targets', await ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].every(b => b.getBoundingClientRect().height >= 43.5)`));
        await click('Edit'); await waitFor(`!!document.getElementById('task-edit-title')`, 'the form on a phone'); await shot('task-page-edit-phone');
        check('the form fits the phone', await wide() <= 0, String(await wide()));
        await click('Cancel'); await waitFor(`!document.getElementById('task-edit-title')`, 'back');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });

        console.log('7. The dock opens the page');
        await ev(`window.__m.add('tpa-agent', 'B', 1, { sleeping: false, board_project: ${JSON.stringify(B)}, board_is_orchestrator: false, board_subscriber_id: 'fe' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'tpa-agent')`, 'the agent', 8000);
        await ev(`window.selectLiveSession('tpa-agent', 'claude', 'tpa-agent-id', 'local')`);
        await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) (document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn')).click(); window.switchAgenticTab('tasks', 'top'); return true; })()`);
        // Selection and board refresh are async: old team rows or private tasks can exist first. Wait for the worker's exact result.
        const ownRow = `#board-task-list .board-task-item[data-kind="board"][data-task-id="${open1}"]`;
        await waitFor(`!!document.querySelector('${ownRow} .board-task-name') && document.querySelectorAll('#board-task-list .board-task-item[data-kind="board"]').length === 1`, 'the worker\'s assigned board task', 12000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#board-task-list .board-task-item[data-kind="board"]')].map(r => r.dataset.taskId)`), [String(open1)], 'the worker dock contains only its assigned board task');
        await ev(`document.querySelector('${ownRow} .board-task-name').click(); true`);
        await waitFor(`document.querySelector('#preview-pane #team-task-title')?.textContent === '#${open1} Build the task page'`, 'the assigned task from the worker dock, in the shared preview (#8788)', 12000);
        check('a task name in the dock opens its detail in the shared preview pane and no dialog', await ev(`getComputedStyle(document.getElementById('task-detail-modal')).display === 'none'`));
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
