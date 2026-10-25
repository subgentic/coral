// A goal's page puts its tasks in a column beside it (#7665, UI/UX's mock): the goal's details are the main pane, its tasks a 340 px column at the right (search, Open then Done, a state chip and who on each row), a task picked
// from the column is the task page (#7644) in the main pane with a back link "Goal: <title>" and the column beside it; "Done by <name>" names who built a done task (worked_by: the author of a reviewed task, not the
// orchestrator it was handed to). On a phone the goal, its task list and a task are three screens, 44 px targets. Real board on the isolated dev server (removed again). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'gsc-' + Date.now().toString(36);
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); new Promise(r => setTimeout(r, 350))`); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rows = () => ev(`[...document.querySelectorAll('.goal-side-row')].map(b => ({ title: b.querySelector('.goal-side-title').textContent, who: b.querySelector('.goal-side-who').textContent, chip: b.querySelector('.goal-side-meta > :first-child').textContent, current: b.getAttribute('aria-current') }))`);
    const openGoal = async (goal, tab = 'goals') => { await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: ${JSON.stringify(tab)}, item: ${goal} }); true`); await waitFor(`!!document.querySelector('.goal-split') && document.querySelectorAll('.goal-side-row').length > 0 && document.querySelector('.goal-side').getClientRects().length + document.querySelector('.goal-main').getClientRects().length > 0`, 'the goal page', 15000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer'], ['rev', 'QA Engineer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Tasks and goals stay readable', outcome: 'A goal page shows its tasks in a column.', done_when: 'The operator approves it on screenshots.' }); assert.equal(g.status, 201, JSON.stringify(g));
        const goal = g.body.id;
        const mk = async (title, assigned) => { const r = await api('POST', `/api/board/${B}/tasks`, { title, body: 'Text of ' + title, created_by: 'orch', priority: 'medium', goal_id: goal, ...(assigned ? { assigned_to: assigned } : {}) }); assert.ok(r.status < 300, JSON.stringify(r)); return r.body.id || r.body.task.id; };
        const built = await mk('Build the column', 'dev'), second = await mk('Second open task'), third = await mk('Third open task');
        // a task the developer built and the orchestrator completed after a review: its assignee is the orchestrator, its worker the developer
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'dev', task_id: built })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${built}/submit-review`, { subscriber_id: 'dev', reason: 'review pending', message: 'Built.', artifacts: [] })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${built}/complete`, { subscriber_id: 'orch', message: 'Accepted.' })).status, 200);

        console.log('1. The goal page: its details, and its tasks in a column at the right');
        await openGoal(goal);
        const lay = await ev(`(() => { const m = document.querySelector('.goal-main').getBoundingClientRect(), s = document.querySelector('.goal-side').getBoundingClientRect(); return { sideRight: s.left >= m.right - 1, w: Math.round(s.width), title: document.getElementById('goals-detail-title').textContent, head: document.querySelector('.goal-side-head').textContent, groups: [...document.querySelectorAll('.goal-side-group')].map(h => h.textContent), table: !!document.querySelector('#team-panel-goals .team-table'), add: !!document.querySelector('.goal-main .goals-pinbar .goals-add-task'), label: document.querySelector('.goal-side').getAttribute('aria-label') }; })()`);
        check('the column is beside the goal, 340 px wide, with the goal in the main pane and no task table', lay.sideRight && lay.w === 340 && lay.title === 'Tasks and goals stay readable' && !lay.table && lay.add, JSON.stringify(lay));
        check('the header counts the tasks and the groups are Open then Done', /^Tasks\s*2 open, 1 done$/.test(lay.head) && JSON.stringify(lay.groups) === JSON.stringify(['Open 2', 'Done 1']), JSON.stringify([lay.head, lay.groups]));
        const rs = await rows();
        check('each row: the title with its number, a state chip, and who', rs.length === 3 && rs[0].title === '#' + second + ' Second open task' && rs[0].chip === 'Queued' && rs[0].who === 'Nobody yet', JSON.stringify(rs));
        check('a done task says who built it, not the orchestrator who completed it ("Done by dev")', rs[2].title === '#' + built + ' Build the column' && rs[2].who === 'Done by dev' && rs[2].chip === 'Done', JSON.stringify(rs[2]));
        await shot('goal-column-desktop');

        console.log('2. Search');
        await ev(`(() => { const s = document.querySelector('.goal-side-search'); s.value = 'third'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        check('the search narrows the column', JSON.stringify((await rows()).map(r => r.title)) === JSON.stringify(['#' + third + ' Third open task']));
        await ev(`(() => { const s = document.querySelector('.goal-side-search'); s.value = 'zzz'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        check('and says when nothing matches', /No task matches/.test(await ev(`document.querySelector('.goal-side-list').textContent`)));
        await ev(`(() => { const s = document.querySelector('.goal-side-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

        console.log('3. A task picked from the column is its page in the main pane');
        await ev(`document.querySelector('.goal-side-row[data-task-id="${second}"]').click(); true`);
        await waitFor(`!!document.querySelector('.goal-main #team-task-title') && !!document.querySelector('.goal-main .goals-pinbar .btn')`, 'the task in the main pane', 12000);
        const pick = await ev(`(() => ({ title: document.getElementById('team-task-title').textContent, back: document.querySelector('.goal-main .goals-back').textContent.trim(), cur: [...document.querySelectorAll('.goal-side-row[aria-current="true"]')].map(b => b.dataset.taskId), side: document.querySelector('.goal-side').getClientRects().length > 0, bar: [...document.querySelectorAll('.goal-main .goals-pinbar .btn')].map(b => b.textContent), focus: document.activeElement && document.activeElement.id }))()`);
        check('the task page (#7644) is in the main pane with the back link "Goal: <title>", the column stays and marks the row', pick.title === '#' + second + ' Second open task' && /Goal: Tasks and goals stay readable$/.test(pick.back) && JSON.stringify(pick.cur) === JSON.stringify([String(second)]) && pick.side && pick.bar.includes('Edit') && pick.focus === 'team-task-title', JSON.stringify(pick));
        await shot('goal-column-task-desktop');
        await ev(`[...document.querySelectorAll('.goal-main .goals-pinbar .btn')].find(b => b.textContent === 'Complete').click(); true`);
        await waitFor(`!!document.getElementById('task-complete-message')`, 'the completion form');
        await ev(`document.getElementById('task-complete-message').value = 'Done from the goal page'; [...document.querySelectorAll('.goal-main .goals-pinbar .btn')].find(b => b.textContent === 'Complete').click(); true`);
        await waitFor(`document.querySelector('.goal-side-head').textContent.replace(/\\s+/g, ' ').includes('1 open, 2 done')`, 'the column to move it to Done', 15000);
        check('an action on the task page moves the row in the column (Open 1, Done 2)', JSON.stringify((await ev(`[...document.querySelectorAll('.goal-side-group')].map(h => h.textContent)`))) === JSON.stringify(['Open 1', 'Done 2']));
        await ev(`document.querySelector('.goal-main .goals-back').click(); true`);
        await waitFor(`!!document.querySelector('.goal-main #goals-detail-title') && document.activeElement && document.activeElement.classList.contains('goal-side-row')`, 'back on the goal, the focus on the task row', 8000);
        check('the back link returns to the goal with the focus on the task\'s row', await ev(`document.activeElement.dataset.taskId === '${second}'`));

        console.log('4. A phone: the goal, its task list and a task are three screens');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await openGoal(goal);
        const vis = sel => ev(`!!document.querySelector(${JSON.stringify(sel)}) && document.querySelector(${JSON.stringify(sel)}).getClientRects().length > 0`);
        check('the goal is the first screen: its details and a "Tasks, 1 open, 2 done" button, no column', await vis('.goal-main #goals-detail-title') && !(await vis('.goal-side')) && /Tasks, 1 open, 2 done/.test(await ev(`document.querySelector('.goal-tasks-open').textContent`)));
        check('the button is a 44 px target', await ev(`document.querySelector('.goal-tasks-open').getBoundingClientRect().height >= 43.5`));
        await shot('goal-phone-goal');
        await ev(`document.querySelector('.goal-tasks-open').click(); true`);
        await waitFor(`document.querySelector('.goal-side').getClientRects().length > 0`, 'the list screen');
        check('the list is the next screen: the column, a way back to the goal, no main pane; rows are 44 px', await vis('.goal-side-back') && !(await vis('.goal-main')) && await ev(`[...document.querySelectorAll('.goal-side-row')].every(b => b.getBoundingClientRect().height >= 43.5)`));
        await shot('goal-phone-list');
        await ev(`document.querySelector('.goal-side-row[data-task-id="${third}"]').click(); true`);
        await waitFor(`!!document.querySelector('.goal-main #team-task-title') && document.querySelector('.goal-main').getClientRects().length > 0`, 'the task screen');
        check('a task is the third screen: its page, back named Tasks, no column', await vis('.goal-main #team-task-title') && !(await vis('.goal-side')) && (await ev(`document.querySelector('.goal-main .goals-back').textContent.trim()`)).endsWith('Tasks'));
        await shot('goal-phone-task');
        await ev(`document.querySelector('.goal-main .goals-back').click(); true`);
        await waitFor(`document.querySelector('.goal-side').getClientRects().length > 0`, 'back on the list');
        check('back from the task is the list, back from the list is the goal', await vis('.goal-side-back'));
        await ev(`document.querySelector('.goal-side-back').click(); true`);
        await waitFor(`!!document.querySelector('.goal-main #goals-detail-title') && document.querySelector('.goal-main').getClientRects().length > 0`, 'back on the goal');
        check('the goal again, nothing wider than the screen', await ev(`document.documentElement.scrollWidth - innerWidth <= 0`));
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
