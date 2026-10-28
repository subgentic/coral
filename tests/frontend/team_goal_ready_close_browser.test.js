// #10604 (Beta team page pass), 2: when every task of an active goal is done, its row in the team's Goals tab says "All tasks done: close the goal?" with a Close button that goes straight to the close dialog (Done chosen). A goal with an open task has neither.
// A real board on the isolated dev server (removed again), at 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'goal-ready-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            if (!mobile) {
                assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
                const gDone = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(gDone.status, 201);
                const gOpen = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Keep going' }); assert.equal(gOpen.status, 201);
                const idDone = gDone.json.id || gDone.json.goal.id, idOpen = gOpen.json.id || gOpen.json.goal.id;
                for (const [goal, title, finish] of [[idDone, 'Task A', true], [idDone, 'Task B', true], [idOpen, 'Task C', false]]) {
                    const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title, goal_id: goal, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300, JSON.stringify(t));
                    if (!finish) continue;
                    const id = t.json.id || t.json.task.id;
                    assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: id })).status < 300);
                    assert.ok((await api('POST', `/tasks/${id}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
                }
            }
            await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr.dt-row').length >= 2`, `${w}: the goals`, 20000);
            const rows = await ev(`[...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')].map(r => ({ text: r.textContent.replace(/\\s+/g, ' ').trim(), note: !!r.querySelector('.goals-ready-note'), close: [...r.querySelectorAll('button.goals-ready-close')].map(b => b.getAttribute('aria-label')) }))`);
            const done = rows.find(r => r.text.includes('Ship the pilot')), open = rows.find(r => r.text.includes('Keep going'));
            assert.ok(done && open, `${w}: both goals are listed: ${JSON.stringify(rows)}`);
            assert.ok(done.note && /All tasks done: close the goal\?/.test(done.text), `${w}: the finished goal's row says so: ${JSON.stringify(done)}`);
            assert.deepEqual(done.close, ['Close the goal: Ship the pilot'], `${w}: with a Close that names the goal`);
            assert.ok(!open.note && !open.close.length, `${w}: a goal with an open task has neither: ${JSON.stringify(open)}`);
            await ev(`document.querySelector('#team-panel-goals button.goals-ready-close').click(); true`);
            await waitFor(`!!document.querySelector('dialog.goals-close-dialog[open]')`, `${w}: the close dialog`, 8000);
            const dlg = await ev(`(() => { const d = document.querySelector('dialog.goals-close-dialog[open]'); return { goal: (d.querySelector('.goals-close-goal') || {}).textContent, done: !!(d.querySelector('input[name="goal-close-state"][value="done"]') || {}).checked }; })()`);
            assert.deepEqual(dlg, { goal: 'Ship the pilot', done: true }, `${w}: the dialog is for that goal with Done chosen`);
            await ev(`document.querySelector('dialog.goals-close-dialog[open]').close(); true`);
        }
        console.log('\nPASS a goal whose tasks are all done offers to be closed from its row');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
