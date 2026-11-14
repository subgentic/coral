// A stylesheet that never answers must not keep a page from drawing (#16403, Windows gate 7: task_link_missing_browser sat on /tasks/77 with no not-found view at all, nf:null for 16 s, no console error, no failed file).
// The not-found view waits for its stylesheet (css/not_found.css) before it makes the view; the link's load event never came, so the wait never ended. A sheet that has not answered in a few seconds is
// given up on (the page is readable without it) and the view shows. Here the stylesheet's request is held and never answered until the suite ends. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { goneId } = require('./helpers/task_ids');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'task-styles-' + Date.now().toString(36), boards = [board];
    const held = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await client.Fetch.enable({ patterns: [{ urlPattern: '*/css/not_found.css*' }] });
        safePaused(client, async e => { held.push(e.requestId); }); // never answered while the page runs: the sheet's request just does not come back
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' })).status, 200);
        const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'Orchestrator', title: 'Build a small calculator', body: 'x', priority: 'medium', assigned_to: 'Orchestrator' }); assert.ok(t.status < 300, JSON.stringify(t));
        const GONE = goneId(t.body && (t.body.id || (t.body.task && t.body.task.id))); // a number no task has: ids are one counter for the server, so a fixed 77 was the suite's own task on a long shard (#16403)
        await Page.navigate({ url: BASE + `/team/${board}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await waitFor(`!!document.querySelector('#mb-messages .mb-queue-run .mb-queue-task')`, 'the task link', 15000);
        await ev(`document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').dataset.taskId = '${GONE}'; document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').click(); true`);
        await waitFor(`location.pathname === ${JSON.stringify(`/team/${board}/tasks/${GONE}`)}`, 'the task route', 10000);
        await waitFor(`(() => { const v = document.getElementById('not-found-view'); return !!v && !v.hidden && /${GONE}/.test(v.textContent); })()`, 'the not-found view naming the missing task while its stylesheet never answers', 15000,
            `({ tab: location.pathname, nf: !!document.getElementById('not-found-view') })`).catch(e => { throw new Error(e.message + ` (stylesheet requests held: ${held.length})`); });
        assert.ok(held.length >= 1, 'the stylesheet request was held (so the test held what it means to): ' + held.length);
        console.log(`the view shows with the stylesheet held (${held.length} request held)`);
        console.log('\nPASS A page whose stylesheet never answers still draws');
    } finally {
        for (const id of held) await client.Fetch.continueRequest({ requestId: id }).catch(() => {});
        await removeBoards(ev, boards).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
