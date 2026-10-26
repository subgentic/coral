// Selecting tasks in the Inbox's Tasks folder (#7776, #7743): the table's checkboxes, the selection bar in the toolbar's place ("N selected", Mark done, Clear), and Mark done calling each task's own Complete. Real board, tasks
// assigned to the Operator, on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'mt-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-s' })).status, 200);
        const ids = [];
        for (const t of ['One', 'Two', 'Three']) { const r = await api('POST', `/api/board/${B}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator' }); assert.ok(r.status < 300, JSON.stringify(r)); ids.push(r.body.id || r.body.task.id); }
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length === 3`, 'the three tasks', 15000);
        const cb = i => `document.querySelectorAll('#group-table-view tbody .dt-check input')[${i}]`;
        const state = () => ev(`(() => { const r = document.querySelector('#group-table-view .gt-toolbar'), bar = document.querySelector('#group-table-view .dt-bar'); return { selecting: r.classList.contains('team-toolbar-selecting'), count: bar && !bar.hidden ? bar.querySelector('.dt-bar-count').textContent : '', actions: bar ? [...bar.querySelectorAll('button')].map(b => b.textContent) : [] }; })()`);
        assert.equal((await state()).selecting, false);
        await ev(`${cb(0)}.click(); ${cb(1)}.click(); true`);
        let s = await state();
        assert.deepEqual([s.selecting, s.count, s.actions], [true, '2 selected', ['Mark done', 'Clear']], 'the bar takes the toolbar line ' + JSON.stringify(s));
        await ev(`[...document.querySelectorAll('#group-table-view .dt-bar-action')].find(b => b.textContent === 'Mark done').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length === 1`, 'the two done tasks leave the list', 12000);
        await ev(`[...document.querySelectorAll('.toast')].some(t => /Marked done 2 tasks/.test(t.textContent))`).then(ok => assert.ok(ok, 'the toast says two were marked done'));
        assert.equal((await state()).selecting, false, 'the toolbar is back');
        // the table's order is the Inbox's (not the order they were made in): the two rows that were selected are the two the server completed, and the one left is still open
        const st = await Promise.all(ids.map(async id => { const t = await api('GET', `/api/board/${B}/tasks/${id}`); return [id, t.body.title, t.body.status || t.body.task.status]; }));
        const left = await ev(`document.querySelector('#group-table-view .dt-table tbody .dt-primary').textContent`);
        assert.equal(st.filter(x => x[2] === 'completed').length, 2, 'the server completed two ' + JSON.stringify(st));
        assert.deepEqual(st.filter(x => x[2] !== 'completed').map(x => x[1]), [left], 'the one still open is the one still listed ' + JSON.stringify(st));
        console.log('PASS Inbox Tasks: select and Mark done through the selection bar');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
