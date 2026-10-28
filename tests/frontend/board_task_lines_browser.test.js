// #10604 (Beta team page pass), 3: the Board has a quiet line when a task is claimed and when it is done, in words that say who and which: "Boss took #1", "Boss finished #1", not the counts "1 claimed, 1 finished" of a run
// of the task queue's lines. A real board on the isolated dev server (removed again), at 1280 and 390; a long run (five claims) is still counted.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'task-lines-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    let taskId = 0; // the board's task numbers are the server's, not 1
    const runLabel = () => ev(`(() => { const r = document.querySelector('#mb-messages .mb-queue-run'); const l = r && (r.querySelector('.mb-queue-run-label, .mb-queue-label, summary, .mb-queue-head') || r); return l ? l.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            if (!mobile) {
                assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
                assert.ok((await api('POST', '/messages', { subscriber_id: 'Boss', content: 'hello board' })).status < 300);
                const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Do a thing', assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300);
                const id = taskId = t.json.id || t.json.task.id;
                assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: id })).status < 300);
                assert.ok((await api('POST', `/tasks/${id}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
            }
            await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(B)}, { tab: 'messages' }); true`);
            await waitFor(`!!document.querySelector('#mb-messages .mb-queue-run')`, `${w}: the queue's lines on the Board`, 20000);
            const text = await ev(`document.querySelector('#mb-messages .mb-queue-run').textContent.replace(/\\s+/g, ' ').trim()`);
            assert.ok(text.includes(`#${taskId} created; Boss took #${taskId}; Boss finished #${taskId}`), `${w}: the lines say who took and who finished which task: ${text}`);
            assert.ok(!/1 task created, 1 claimed/.test(text), `${w}: and are not the counts of a run: ${text}`);
        }
        console.log('\nPASS the Board says who took and who finished a task');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
