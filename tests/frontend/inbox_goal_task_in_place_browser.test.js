// A task opened from the Inbox goal page stays in the Inbox (#8861, Goal #73 step 2, the Operator's shot): the goal's task list opens the task at /inbox/tasks/<team>/<id>, in the one shared task screen, never on the team
// page; Back returns to the goal. At 1280, and at 390 where the goal's tasks are the screen after the "Tasks, N open" button. Real board, goal and task on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gt-' + Date.now().toString(36), TITLE = 'Ship the in-place goal', TASK = 'Open me in the Inbox';
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: TITLE, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201);
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        const t = await api('POST', `/api/board/${B}/tasks`, { title: TASK, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator', goal_id: G }); assert.ok(t.status < 300, JSON.stringify(t));
        const T = t.body.id || t.body.task.id;
        const goalUrl = `/inbox/goals/${B}/${G}`, taskUrl = `/inbox/tasks/${B}/${T}`;

        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            console.log(`${at}a goal's task opens in the Inbox, Back returns to the goal`);
            await load(goalUrl);
            await waitFor(`document.querySelector('#inbox-page #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'the Inbox goal', 15000);
            if (mobile) await ev(`document.querySelector('#inbox-page .goal-tasks-open').click(); true`); // a phone's goal page: the task list is the next screen
            await waitFor(`!!document.querySelector('#inbox-page .goal-side .dt-primary[data-task-id="${T}"]')`, 'the goal\'s task row', 15000);
            await ev(`document.querySelector('#inbox-page .goal-side .dt-primary[data-task-id="${T}"]').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(taskUrl)} && document.querySelector('#inbox-page .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the task in the Inbox at ' + taskUrl, 15000);
            assert.equal(await ev(`getComputedStyle(document.getElementById('team-page-view')).display === 'none'`), true, at + 'the team page is not on screen');
            assert.equal(await ev(`document.body.getAttribute('data-nav-tab')`), 'hub-inbox', at + 'still the Inbox tab');
            await shot(`inbox-goal-task-landing-${w}`);
            await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(goalUrl)} && document.querySelector('#inbox-page #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'Back returns to the goal', 15000);
            await shot(`inbox-goal-task-back-${w}`);
            console.log('   ✓');

            console.log(`${at}a task's Goal line opens the goal in the Inbox, Back returns to the task`);
            await load(taskUrl);
            await waitFor(`document.querySelector('#inbox-page .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the Inbox task', 15000);
            await ev(`[...document.querySelectorAll('#inbox-page .goals-facts dd button.team-link')].find(b => b.textContent === ${JSON.stringify(TITLE)}).click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(goalUrl)} && document.querySelector('#inbox-page #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'the goal in the Inbox at ' + goalUrl, 15000);
            assert.equal(await ev(`getComputedStyle(document.getElementById('team-page-view')).display === 'none'`), true, at + 'the team page is not on screen');
            await shot(`inbox-task-goal-landing-${w}`);
            await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(taskUrl)} && document.querySelector('#inbox-page .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'Back returns to the task', 15000);
            await shot(`inbox-task-goal-back-${w}`);
            console.log('   ✓');

            console.log(`${at}a task opened by address (a reload or a deep link): Back goes to the folder`);
            await load(taskUrl);
            await waitFor(`document.querySelector('#inbox-page .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the task by address', 15000);
            await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
            await waitFor(`location.pathname === '/inbox/tasks' && document.getElementById('group-table-view')?.getClientRects().length > 0`, 'Back goes to the Tasks folder', 15000);
            console.log('   ✓');
        }
        console.log('PASS inbox goal task in place: the goal\'s task opens in the Inbox and the task\'s Goal opens in the Inbox, Back returns each time, at 1280 and 390');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
