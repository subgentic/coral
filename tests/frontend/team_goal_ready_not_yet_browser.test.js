// #10692 (follow-up to #10604): a goal the person said Not yet to on its page stops asking "All tasks done: close the goal?" on its row in the team's Goals tab, and loses the row's Close. The goal page and the row read the same Not yet list.
// A real board on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'goal-notyet-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const rowOf = (title) => ev(`(() => { const r = [...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')].find(r => r.textContent.includes(${JSON.stringify(title)})); return r ? { note: !!r.querySelector('.goals-ready-note'), close: r.querySelectorAll('button.goals-ready-close').length } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(g.status, 201);
        const gid = g.json.id || g.json.goal.id;
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task A', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300, JSON.stringify(t));
        const tid = t.json.id || t.json.task.id;
        assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
        assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);

        await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr.dt-row').length >= 1`, 'the goals', 20000);
        const before = await rowOf('Ship the pilot');
        assert.deepEqual(before, { note: true, close: 1 }, `before Not yet the row asks: ${JSON.stringify(before)}`);

        // open the goal's page and say Not yet to its all-done strip
        await ev(`document.querySelector('#team-panel-goals tbody tr.dt-row button[data-goal-id]').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .goals-alldone-not-yet')`, 'the goal page strip', 8000);
        await ev(`document.querySelector('#team-panel-goals .goals-alldone-not-yet').click(); true`);
        await waitFor(`!document.querySelector('#team-panel-goals .goals-alldone')`, 'the strip goes quiet', 8000);

        // back to the list: the row is quiet too
        await ev(`document.querySelector('#team-panel-goals .goals-back').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr.dt-row').length >= 1`, 'the list is back', 8000);
        const after = await rowOf('Ship the pilot');
        assert.deepEqual(after, { note: false, close: 0 }, `after Not yet the row is quiet: ${JSON.stringify(after)}`);
        console.log('\nPASS Not yet on a goal page quiets its row in the Goals tab');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
