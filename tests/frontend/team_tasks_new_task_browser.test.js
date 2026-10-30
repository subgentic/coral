// New task on the team's Tasks page (#11051, the phone smoke of v2.0.4): after "Task created" the list shows the task at once, with no reload and no wait for the 15 s read (it said "No tasks yet" and "Open 0"). 390 and 1280 px, a team with no task.
// Real board over the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tnew-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            if (w === 1280) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status, 200);
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
            const title = `Made from the page at ${w}`;
            await waitFor(`!!document.querySelector('#team-panel-tasks .btn-create-task') && document.querySelector('#team-panel-tasks .btn-create-task').getClientRects().length > 0`, `${w}: the New task button`, 15000);
            await ev(`document.querySelector('#team-panel-tasks .btn-create-task').click(); true`);
            await waitFor(`!!document.getElementById('create-task-title')`, `${w}: the dialog`, 8000);
            await ev(`document.getElementById('create-task-title').value = ${JSON.stringify(title)}; document.getElementById('create-task-submit').click(); true`);
            await waitFor(`[...document.querySelectorAll('#team-panel-tasks .dt-table tbody tr')].some(r => r.textContent.includes(${JSON.stringify(title)}))`, `${w}: the new task is in the list without a reload`, 4000);
            assert.ok(!/No tasks yet/.test(await ev(`document.querySelector('#team-panel-tasks').textContent`)) , `${w}: "No tasks yet" is gone`);
            console.log(`   ${w}: ok`);
        }
        console.log('PASS a task made from the Tasks page is in its list at once');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
