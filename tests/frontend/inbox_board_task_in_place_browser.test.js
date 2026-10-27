// A task referenced in an Inbox Board history message opens in the Inbox (#8861, Goal #73 step 2): the `#N` link of a message in /inbox/boards/<team> opens /inbox/tasks/<team>/<id> in the shared task screen, never the
// team page; Back returns to the board. At 1280 and 390. Real board, task and message on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'bt-' + Date.now().toString(36), TASK = 'Referenced from the board';
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status < 300);
        const t = await api('POST', `/api/board/${B}/tasks`, { title: TASK, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator' }); assert.ok(t.status < 300, JSON.stringify(t));
        const T = t.body.id || t.body.task.id;
        assert.ok((await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Operator', content: `See task #${T}` })).status < 300);
        const boardUrl = `/inbox/boards/${B}`, taskUrl = `/inbox/tasks/${B}/${T}`;
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            console.log(`${at}a task referenced in Board history opens in the Inbox, Back returns to the board`);
            await load(boardUrl);
            await waitFor(`!![...document.querySelectorAll('#inbox-page .mb-message')].find(r => r.textContent.includes('See task #${T}'))`, 'the message in Board history', 15000);
            await ev(`(() => { const row = [...document.querySelectorAll('#inbox-page .mb-message')].find(r => r.textContent.includes('See task #${T}')); row.querySelector('.mb-row-toggle').click(); row.querySelector('.mb-task-link').click(); return true; })()`);
            await waitFor(`location.pathname === ${JSON.stringify(taskUrl)} && document.querySelector('#inbox-page .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the task in the Inbox at ' + taskUrl, 15000);
            assert.equal(await ev(`getComputedStyle(document.getElementById('team-page-view')).display === 'none'`), true, at + 'the team page is not on screen');
            await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(boardUrl)} && !!document.querySelector('#inbox-page .mb-message')`, 'Back returns to the board', 15000);
            console.log('   ✓');
        }
        console.log('PASS inbox board task in place: a task referenced in Board history opens in the Inbox, Back returns to the board, at 1280 and 390');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
