// #11585 (the operator: "expand everything by default, including grouped system lines like '1 task created, 1 claimed', since users like to see what shows up"): a run of the task queue's lines in the team board's chat is
// open by default, its lines visible; a person can close it, and that is remembered for the board (a run that grows by a poll stays closed, a reload keeps it closed, another board is still open); opening it again is
// remembered the same way. A real board on the isolated dev server (removed again), at 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const mk = async (board, title) => { const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'Orchestrator', title, body: 'x', priority: 'medium', assigned_to: 'Orchestrator' }); assert.ok(t.status < 300, JSON.stringify(t)); };
    const open = () => ev(`(() => { const d = document.querySelector('#mb-messages .mb-queue-run'); if (!d) return null; const l = d.querySelector('.mb-queue-line'); return { open: d.open, lines: d.querySelectorAll('.mb-queue-line').length, visible: !!l && l.getClientRects().length > 0 }; })()`);
    const go = async (board) => { await Page.navigate({ url: BASE + `/team/${board}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await waitFor(`!!document.querySelector('#mb-messages .mb-queue-run')`, `${board}: the queue run`, 15000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `, a = `queue-open-a-${width}-` + Date.now().toString(36), b = `queue-open-b-${width}-` + Date.now().toString(36); boards.push(a, b);
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            for (const bd of [a, b]) assert.equal((await api('POST', `/api/board/${bd}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator', session_name: bd })).status, 200);
            await mk(a, 'First task'); await mk(b, 'Other board task');
            await go(a);
            const first = await open(); assert.ok(first.open && first.visible && first.lines >= 1, at + 'a run is open by default with its lines showing: ' + JSON.stringify(first));
            await ev(`document.querySelector('#mb-messages .mb-queue-run > summary').click(); true`);
            await waitFor(`document.querySelector('#mb-messages .mb-queue-run').open === false`, at + 'the person can close it', 5000);
            await mk(a, 'Second task'); // a poll adds a line to the run: it is drawn again and stays as the person left it
            await waitFor(`document.querySelectorAll('#mb-messages .mb-queue-line').length >= 2`, at + 'the run grew', 20000);
            assert.equal((await open()).open, false, at + 'a run that grew stays closed');
            await go(a); assert.equal((await open()).open, false, at + 'a reload keeps the choice for this board');
            await go(b); assert.equal((await open()).open, true, at + 'another board is still open by default');
            await go(a);
            await ev(`document.querySelector('#mb-messages .mb-queue-run > summary').click(); true`);
            await waitFor(`document.querySelector('#mb-messages .mb-queue-run').open === true`, at + 'and open it again', 5000);
            await go(a); assert.equal((await open()).open, true, at + 'opening it again is remembered too');
        }
        console.log('\nPASS board queue runs are open by default and the choice is remembered per board');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
