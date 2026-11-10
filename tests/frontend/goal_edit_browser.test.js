// Edit goal (#15284, Beta walk 16 H1): the goal page has an Edit goal button; it opens the goal's own screen with its title, description and done-when in it, Save changes sends only what changed
// (an unchanged form says so and sends nothing), the page shows the new words and a toast says the team reads the change, and the board carries a line that says who edited it and what the new words are.
// Real server, a made-up board (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gedit-' + Date.now().toString(36);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Habit tracker', outcome: 'A small app', done_when: 'It runs' });
        assert.equal(g.status, 201); const id = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        await Page.navigate({ url: BASE + `/inbox/goals/${B}/${id}` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await waitFor(`!!document.querySelector('#inbox-page .goals-edit')`, 'the goal page has Edit goal', 15000);
        await ev(`document.querySelector('#inbox-page .goals-edit').click(); true`);
        await waitFor(`!!document.querySelector('dialog.goal-editor[open] #goal-new-title')`, 'the editor opens', 15000);
        const filled = await ev(`({ head: document.querySelector('dialog.goal-editor #goals-create-title').textContent, title: document.getElementById('goal-new-title').value, desc: document.getElementById('goal-new-description').value, done: document.getElementById('goal-new-done').value, save: document.querySelector('dialog.goal-editor .goals-actions .btn-primary').textContent })`);
        assert.deepEqual(filled, { head: 'Edit goal', title: 'Habit tracker', desc: 'A small app', done: 'It runs', save: 'Save changes' }, 'the goal\'s own words are in it');
        // nothing changed: said, nothing sent
        await ev(`document.querySelector('dialog.goal-editor form').requestSubmit(); true`);
        await waitFor(`/Nothing has changed/.test(document.querySelector('dialog.goal-editor .goals-field-error').textContent)`, 'an unchanged form says so', 8000);
        // change the title and the done-when
        await ev(`{ const t = document.getElementById('goal-new-title'); t.value = 'Habit tracker v2'; t.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('goal-new-done'); d.value = 'It runs and saves'; d.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('dialog.goal-editor form').requestSubmit(); } true`);
        await waitFor(`!document.querySelector('dialog.goal-editor')`, 'the editor closes after Save', 10000);
        await waitFor(`document.querySelector('#inbox-page .goals-detail-title')?.textContent === 'Habit tracker v2'`, 'the page shows the new title', 10000);
        assert.ok(await ev(`[...document.querySelectorAll('.toast .toast-message')].some(t => /Goal saved\\. The team reads the change on its board/.test(t.textContent))`), 'a toast says what happened');
        const now = await api('GET', `/api/board/${B}/goals/${id}`);
        assert.deepEqual([now.body.title, now.body.outcome, now.body.done_when], ['Habit tracker v2', 'A small app', 'It runs and saves'], 'only the changed words were written: ' + JSON.stringify(now.body));
        const msgs = JSON.stringify((await api('GET', `/api/board/${B}/messages/all?limit=30`)).body);
        assert.ok(msgs.includes(`Goal #${id} was edited by Operator`) && msgs.includes('Habit tracker v2') && msgs.includes('It runs and saves'), 'the board says who edited it and the new words: ' + msgs.slice(0, 400));
        // a closed goal has no Edit goal (reopen it first): Security's SHOULD on #15284
        assert.equal((await api('POST', `/api/board/${B}/goals/${id}/close`, { subscriber_id: 'Operator', reason: 'shipped' })).status, 200);
        await Page.navigate({ url: BASE + `/inbox/goals/${B}/${id}` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await waitFor(`document.querySelector('#inbox-page .goals-detail-title')?.textContent === 'Habit tracker v2'`, 'the closed goal opens', 15000);
        assert.equal(await ev(`!!document.querySelector('#inbox-page .goals-edit')`), false, 'a closed goal has no Edit goal');
        console.log('PASS Edit goal: the goal\'s words in its own screen, only changes saved, the board says who edited it');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
