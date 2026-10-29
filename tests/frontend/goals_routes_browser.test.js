// The Goals view against the REAL goals routes (#7113, #7087): goals and tasks are made through the API of the isolated server, then read, opened and created through the view. Checks the answers the
// adapter relies on: the list asked for every state, the rollup's numbers in the sentence, a goal's tasks from tasks?goal=, a refused create's code, a closed goal under Done. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = `goals-real-${Date.now()}`;
    const api = (method, path, body) => ev(`fetch('/api/board/${board}${path}', { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const texts = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await api('POST', '/messages', { subscriber_id: 'Operator', as: 'Operator', content: 'a board for goals' });
        const g1 = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship it', done_when: 'it is shipped', outcome: 'Shipped.' });
        assert.equal(g1.status, 201, JSON.stringify(g1)); const id1 = g1.json.id || (g1.json.goal && g1.json.goal.id);
        const g2 = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Proposed idea', state: 'proposed' });
        assert.equal(g2.status, 201);
        const g3 = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Already finished' });
        const id3 = g3.json.id || (g3.json.goal && g3.json.goal.id);
        for (const title of ['First task', 'Second task']) { const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title, goal_id: id1 }); assert.ok(t.status < 300, `a task is linked at create: ${JSON.stringify(t)}`); }
        const closed = await api('POST', `/goals/${id3}/close`, { subscriber_id: 'Operator', reason: 'done in a test' });
        assert.equal(closed.status, 200, JSON.stringify(closed));
        console.log('the view reads what the routes answer');
        await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(board)}, { tab: 'goals' }); true`); // the goals are the team page's Goals tab (#8129: the board's Goals face is gone)
        const rows = () => texts('#team-panel-goals .dt-table tbody tr');
        // the tab opens on Active (#8517): one goal; All lists the three, the closed one too (the list asks for every state)
        await waitFor(`document.querySelectorAll('#team-panel-goals .dt-table tbody tr').length === 1`, 'the one active goal the tab opens on', 10000);
        await ev(`[...document.querySelectorAll('#team-panel-goals .goals-chip')].find(c => /^All\\b/.test(c.textContent.trim())).click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .dt-table tbody tr').length === 3`, 'three goals (the closed one too: the list asks for every state)', 10000);
        assert.deepEqual(await texts('#team-panel-goals .goals-chip'), ['All 3', 'Active 1', 'Blocked 0', 'Proposed 1', 'Done 1', 'Dropped 0']);
        assert.ok((await rows()).some(r => /^Ship it.*Active0 of 2 done/.test(r)), 'the rollup\'s numbers: 0 of 2 done ' + JSON.stringify(await rows()));
        assert.ok((await rows()).some(r => /^Already finished.*Done/.test(r)), 'a closed goal is Done ' + JSON.stringify(await rows()));
        await ev(`[...document.querySelectorAll('#team-panel-goals .dt-table tbody tr')].find(r => r.textContent.startsWith('Ship it')).querySelector('.dt-primary').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .dt-row').length >= 2 && /First task/.test(document.getElementById('team-panel-goals').textContent)`, 'the goal\'s two tasks from tasks?goal=', 10000);
        assert.ok((await texts('#team-panel-goals .dt-primary')).includes('First task') && (await texts('#team-panel-goals .dt-primary')).includes('Second task'), 'the goal\'s tasks ' + JSON.stringify(await texts('#team-panel-goals .dt-primary')));
        console.log('New goal through the real route');
        await ev(`window.history.back(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .goals-new')`, 'the goals list again', 8000);
        await ev(`document.querySelector('#team-panel-goals .goals-new').click(); true`);
        await waitFor(`!!document.querySelector('dialog.goals-dialog[open]')`, 'the dialog', 3000);
        await ev(`document.getElementById('goal-new-title').value = 'x'.repeat(250); document.querySelector('.goals-dialog button[type=submit]').click(); true`);
        await waitFor(`/was not created: /.test(document.querySelector('.goals-field-error').textContent)`, 'the refusal', 6000);
        console.log('   a refusal says:', (await texts('.goals-field-error'))[0]);
        await ev(`document.getElementById('goal-new-title').value = 'Made in the dialog'; document.getElementById('goal-new-done').value = 'it shows up'; document.querySelector('.goals-dialog button[type=submit]').click(); true`);
        await waitFor(`!document.querySelector('dialog.goals-dialog')`, 'the dialog to close', 6000);
        await waitFor(`document.querySelectorAll('#team-panel-goals .dt-table tbody tr').length === 4`, 'the new goal in the list', 6000);
        assert.ok((await rows()).some(r => r.startsWith('Made in the dialog')));
        const listed = await api('GET', '/goals');
        assert.ok(listed.json.goals.some(g => g.title === 'Made in the dialog'), 'and the route has it');
        console.log('PASS the Goals view against the real routes');
    } finally { await removeBoards(ev, [board]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
