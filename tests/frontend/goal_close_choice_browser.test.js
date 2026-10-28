// #10717 (Desktop tester #10714, moment 2): the Close goal dialog of a goal with open tasks opens with nothing chosen (it used to preselect Dropped, so one Enter dropped the goal) and Close stays off until Done or Dropped is picked;
// after Done with a task still open the page says "Done, 1 task left open", not "0 of 1 task done" beside Done. 1280 and 390, a real board.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `, board = `goal-close-${width}-` + Date.now().toString(36); boards.push(board);
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
            assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
            const g = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'Close me with care', outcome: 'One goal', done_when: 'A person chooses' }); assert.equal(g.status, 201); const id = g.body.id;
            assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
            assert.ok((await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', title: 'Still open', body: 'x', priority: 'medium', goal_id: id })).status < 300);
            await Page.navigate({ url: BASE + `/inbox/goals/${board}/${id}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
            await waitFor(`!!document.querySelector('#inbox-page .goals-close')`, at + 'the goal page', 15000);
            await ev(`document.querySelector('#inbox-page .goals-close').click(); true`);
            await waitFor(`!!document.querySelector('.goals-close-dialog[open]')`, at + 'the Close dialog', 5000);
            const d = await ev(`(() => { const f = document.querySelector('.goals-close-dialog'); return { checked: f.querySelectorAll('input[name="goal-close-state"]:checked').length, off: f.querySelector('button[type="submit"]').disabled, focus: document.activeElement && document.activeElement.name }; })()`);
            assert.deepEqual(d, { checked: 0, off: true, focus: 'goal-close-state' }, at + 'nothing chosen, Close off, the keyboard on the choice: ' + JSON.stringify(d));
            await ev(`document.getElementById('goal-close-reason').value = 'Because'; document.querySelector('.goals-close-dialog form').requestSubmit(); true`); // an Enter in the reason box
            assert.equal((await api('GET', `/api/board/${board}/goals/${id}`)).body.state, 'active', at + 'one Enter does not close the goal');
            await ev(`document.querySelector('.goals-close-dialog input[value="done"]').click(); true`);
            assert.equal(await ev(`document.querySelector('.goals-close-dialog button[type="submit"]').disabled`), false, at + 'choosing turns Close on');
            await ev(`document.querySelector('.goals-close-dialog button[type="submit"]').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-page .goals-reopen')`, at + 'the goal closes', 8000);
            await waitFor(`document.querySelector('#inbox-page .goals-progress') && document.querySelector('#inbox-page .goals-progress').textContent === 'Done, 1 task left open'`, at + 'the progress line says what is left open', 5000);
        }
        console.log('\nPASS Close goal chooses nothing for you, and a goal closed with open tasks says so');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
