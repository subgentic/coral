// A task link whose task cannot be READ (the request fails; it is not a 404) opens the not-found view, never a blank route (#16403, Windows gate 5: task_link_missing_browser sat on /tasks/77 with nothing on screen, nf:null for 15 s on a first try and passed on the retry).
// The read is tried once more when it throws; when both tries fail the view says the task could not be shown. The task's request is refused here, as a dropped one is: first only (once), then every time (always). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const MODES = (process.env.UNREAD_MODES || 'once,always').split(',');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    let mode = 'once', refused = 0, armed = false;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await client.Fetch.enable({ patterns: [{ urlPattern: '*/tasks/77*' }] });
        safePaused(client, async e => {
            if (armed && (mode === 'always' || refused < 1)) { refused++; await client.Fetch.failRequest({ requestId: e.requestId, errorReason: 'ConnectionReset' }); }
            else await client.Fetch.continueRequest({ requestId: e.requestId });
        });
        for (const m of MODES) {
            mode = m; refused = 0; armed = false;
            const board = `task-unread-${m}-` + Date.now().toString(36); boards.push(board);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' })).status, 200);
            const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'Orchestrator', title: 'Build a small calculator', body: 'x', priority: 'medium', assigned_to: 'Orchestrator' }); assert.ok(t.status < 300, JSON.stringify(t));
            await Page.navigate({ url: BASE + `/team/${board}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`!!document.querySelector('#mb-messages .mb-queue-run .mb-queue-task')`, 'the task link', 15000);
            armed = true;
            await ev(`document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').dataset.taskId = '77'; document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(`/team/${board}/tasks/77`)}`, 'the task route', 10000);
            await waitFor(`(() => { const v = document.getElementById('not-found-view'); return !!v && !v.hidden && /77/.test(v.textContent); })()`, `${m}: the not-found view naming task 77 after a failed read`, 15000,
                `({ tab: location.pathname, refused: ${refused}, nf: !!document.getElementById('not-found-view') })`);
            assert.ok(refused >= 1, `${m}: the task's request was refused at least once`);
            if (m === 'always') assert.ok(refused >= 2, `${m}: a throwing read is tried twice before it is given up (${refused} requests refused)`);
            console.log(`${m}: refused ${refused}, the view shows`);
        }
        console.log('\nPASS A task link whose task cannot be read says so');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
