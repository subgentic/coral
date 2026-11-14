// (The modes run refused-always first: once the module has loaded and is cached, a later refusal is not seen.)
// A task link whose task cannot be read opens the not-found view even when the module that draws it fails to load once (#16376, Windows gate 5: the route sat on /tasks/77 with nothing on screen, nf:null for 15 s).
// The load is tried once more; when it fails again a toast says so. The first request for the view's module is refused here, as a dropped one is. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');


const MODES = (process.env.NF_MODES || 'always,once').split(',');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    let mode = 'once', refused = 0;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await client.Fetch.enable({ patterns: [{ urlPattern: '*/np.js*' }] });
        safePaused(client, async e => { if (mode === 'always' || refused < 1) { refused++; await client.Fetch.failRequest({ requestId: e.requestId, errorReason: 'Failed' }); } else await client.Fetch.continueRequest({ requestId: e.requestId }); });
        for (const m of MODES) {
            mode = m; refused = 0;
            const board = `task-gone-${m}-` + Date.now().toString(36); boards.push(board);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' })).status, 200);
            const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'Orchestrator', title: 'Build a small calculator', body: 'x', priority: 'medium', assigned_to: 'Orchestrator' }); assert.ok(t.status < 300, JSON.stringify(t));
            await Page.navigate({ url: BASE + `/team/${board}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`!!document.querySelector('#mb-messages .mb-queue-run .mb-queue-task')`, 'the task link', 15000);
            await ev(`document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').dataset.taskId = '77'; document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(`/team/${board}/tasks/77`)}`, 'the task route', 10000);
            if (m === 'once') {
                await waitFor(`(() => { const v = document.getElementById('not-found-view'); return !!v && !v.hidden && /77/.test(v.textContent); })()`, 'the not-found view naming task 77 after one failed load of its module', 15000,
                    `({ tab: location.pathname, refused: ${refused}, nf: !!document.getElementById('not-found-view') })`);
                assert.ok(refused >= 1, 'the first load of the module was refused, so the retry is what showed the view');
            } else {
                await waitFor(`/Could not load the page that says it was not found/.test(document.body.innerText)`, 'the toast when the module cannot be loaded at all', 15000, `({ refused: ${refused}, toasts: [...document.querySelectorAll('[role=alert],[role=status],.toast')].map(e => e.textContent.trim().slice(0, 100)), tab: location.pathname })`);
                assert.equal(await ev(`!!document.getElementById('not-found-view')`), false, 'no view without its module');
            }
            console.log('PASS ' + m + ': ' + (m === 'once' ? 'one failed load of the not-found module, the view still shows' : 'the module never loads, a toast says so'));
        }
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
