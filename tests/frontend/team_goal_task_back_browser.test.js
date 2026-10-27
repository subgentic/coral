// On the team page a task opened from a goal's task list goes Back to the goal, not the Tasks list (#8898, Goal #73): the Back says the goal ("<- <goal title>", cut at 24 characters), returns to /team/<team>/goals/<id> with the goal
// open; a task opened by address (a deep link) keeps the folder: "<- Tasks" and the Tasks list. At 1280 and 390 (the phone's goal page reaches its task list by the Tasks button). Real board, goal and task on the isolated dev
// server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const B = 'tg-' + Date.now().toString(36), TITLE = 'Ship the team goal', TASK = 'A task of the team goal';
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); };
    const backText = () => ev(`document.querySelector('#team-panel-item .goals-back').textContent.trim()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: TITLE, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201);
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        const t = await api('POST', `/api/board/${B}/tasks`, { title: TASK, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator', goal_id: G }); assert.ok(t.status < 300, JSON.stringify(t));
        const T = t.body.id || t.body.task.id;
        const goalUrl = `/team/${B}/goals/${G}`, taskUrl = `/team/${B}/tasks/${T}`;
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            console.log(`${at}a task opened from the goal goes Back to the goal`);
            await load(goalUrl);
            await waitFor(`document.querySelector('#team-panel-goals #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'the goal', 15000);
            if (mobile) await ev(`document.querySelector('#team-panel-goals .goal-tasks-open').click(); true`);
            await waitFor(`!!document.querySelector('#team-panel-goals .goal-side .dt-primary[data-task-id="${T}"]')`, 'the goal\'s task row', 15000);
            await ev(`document.querySelector('#team-panel-goals .goal-side .dt-primary[data-task-id="${T}"]').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(taskUrl)} && document.querySelector('#team-panel-item .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the task', 15000);
            assert.equal(await backText(), '\u2190 ' + TITLE, at + 'the Back says the goal');
            await shot(`team-goal-task-landing-${w}`);
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(goalUrl)} && document.querySelector('#team-panel-goals #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'Back returns to the goal', 15000);
            await shot(`team-goal-task-back-${w}`);
            console.log('   \u2713');

            console.log(`${at}a task opened by address keeps the Tasks list`);
            await load(taskUrl);
            await waitFor(`document.querySelector('#team-panel-item .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the task by address', 15000);
            assert.equal(await backText(), '\u2190 Tasks', at + 'a deep link says Tasks');
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`location.pathname === '/team/${B}/tasks' && !!document.querySelector('#team-panel-tasks .dt-primary')`, 'Back goes to the Tasks list', 15000);
            console.log('   \u2713');
        }
        console.log('PASS team goal task back: a task opened from the goal goes Back to the goal, a deep link to the Tasks list, at 1280 and 390');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
