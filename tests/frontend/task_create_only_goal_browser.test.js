// A new task joins the board's only open goal (#11258 item 5, the phone NUX pass: 'a new task does not join the only open goal'): with exactly one open goal the Create Task dialog's Goal select starts on it, so the
// first-timer's task is under the goal without an extra choice; with two or more it still starts on No goal, and a closed goal does not count. Real board over the API; the dock's Tasks bar opens the dialog.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'task-one-goal-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-s' })).status, 200);
        const goal = async (title, state) => { const r = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, ...(state ? { state } : {}) }); assert.equal(r.status, 201, JSON.stringify(r)); return r.json.id; };
        const closed = await goal('An old goal');
        assert.equal((await api('POST', `/api/board/${B}/goals/${closed}/close`, { subscriber_id: 'Operator', reason: 'finished', state: 'done' })).status, 200, 'the first goal is closed: a closed goal does not count');
        const only = await goal('Ship the pilot');
        assert.equal((await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title: 'A first task', priority: 'low' })).status, 201);
        await ev(`window.__m.add('og-agent', 'G', 1, { sleeping: false, board_project: ${JSON.stringify(B)} }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'og-agent')`, 'the agent', 8000);
        await ev(`window.selectLiveSession('og-agent', 'claude', 'og-agent-id', 'local'); true`);
        await ev(`(() => { if (document.getElementById('agentic-state').getBoundingClientRect().width < 50) document.getElementById('panel-toggle-btn').click(); document.getElementById('agentic-tab-tasks').click(); return true; })()`);
        await waitFor(`!!document.querySelector('#board-task-bar .btn-create-task') && document.getElementById('agentic-panel-tasks').getBoundingClientRect().width > 50`, 'the Tasks bar', 15000);
        const open = async () => {
            await ev(`document.querySelector('#board-task-bar .btn-create-task').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display !== 'none' && !document.getElementById('create-task-goal').closest('.sv-row').hidden`, 'the dialog with its Goal select', 8000);
            await waitFor(`document.getElementById('create-task-goal').options.length >= 2`, 'the goals listed', 8000);
            return ev(`({ value: document.getElementById('create-task-goal').value, options: [...document.getElementById('create-task-goal').options].map(o => o.textContent) })`);
        };
        const close = async () => { await ev(`document.getElementById('create-task-modal').querySelector('[data-on-click*="hide"], .btn:not(.btn-primary)').click(); true`); await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display === 'none'`, 'the dialog to close', 8000); };

        console.log('1. exactly one open goal (the other is done): the select starts on it');
        let d = await open();
        assert.deepEqual(d.options, ['No goal', 'Ship the pilot'], 'only the open goal is listed: ' + JSON.stringify(d));
        assert.equal(d.value, String(only), 'it starts on the only open goal, not No goal: ' + JSON.stringify(d));
        await ev(`document.getElementById('create-task-title').value = 'Joins the goal'; document.getElementById('create-task-submit').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display === 'none'`, 'the dialog to close', 8000);
        const made = (await api('GET', `/api/board/${B}/tasks?limit=50`)).json;
        const mine = (made.tasks || made).find(t => t.title === 'Joins the goal');
        assert.equal(mine && mine.goal_id, only, 'the new task works toward it: ' + JSON.stringify(mine));
        console.log('   ✓');

        console.log('2. two open goals: it still starts on No goal');
        await goal('Fix the flaky suites');
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__m.add('og-agent', 'G', 1, { sleeping: false, board_project: ${JSON.stringify(B)} }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'og-agent')`, 'the agent', 8000);
        await ev(`window.selectLiveSession('og-agent', 'claude', 'og-agent-id', 'local'); true`);
        await ev(`(() => { if (document.getElementById('agentic-state').getBoundingClientRect().width < 50) document.getElementById('panel-toggle-btn').click(); document.getElementById('agentic-tab-tasks').click(); return true; })()`);
        await waitFor(`!!document.querySelector('#board-task-bar .btn-create-task') && document.getElementById('agentic-panel-tasks').getBoundingClientRect().width > 50`, 'the Tasks bar', 15000);
        d = await open();
        assert.equal(d.options.length, 3, 'both open goals are listed: ' + JSON.stringify(d));
        assert.equal(d.value, '', 'with a choice to make it starts on No goal: ' + JSON.stringify(d));
        console.log('   ✓');
        console.log('PASS a new task joins the only open goal');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
