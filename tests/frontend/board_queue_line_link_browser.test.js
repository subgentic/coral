// #10722 (Desktop tester #10714, moment 1): an opened "Task #N created" line on the board read as the agent's instruction ("assigned to you, run 'coral-board task claim 1' to start") and was not a link. It now says what happened with the
// task's title and who it is for, "Task #N" opens the task, and none of the agent-only text is in what the person reads (the line, its tooltip). 1280 and 390, a real board.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `, board = `queue-line-${width}-` + Date.now().toString(36); boards.push(board);
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
            assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator', session_name: board })).status, 200);
            const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'Orchestrator', title: 'Build a small calculator', body: 'x', priority: 'medium', assigned_to: 'Orchestrator' });
            assert.ok(t.status < 300, JSON.stringify(t)); const id = t.body.id || t.body.task.id;
            await Page.navigate({ url: BASE + `/team/${board}/messages` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
            await waitFor(`!!document.querySelector('#mb-messages .mb-queue-run')`, at + 'the queue line', 15000);
            await ev(`document.querySelector('#mb-messages .mb-queue-run').open = true; true`);
            const line = await ev(`(() => { const l = document.querySelector('#mb-messages .mb-queue-run .mb-queue-line'); const x = l.querySelector('.mb-queue-text'); return { text: x.textContent.trim(), title: x.getAttribute('title') || '', link: !!l.querySelector('button[data-on-click="mb-task-open"]'), all: document.querySelector('#mb-messages .mb-queue-run').textContent }; })()`);
            assert.ok(new RegExp(`^Task #${id} created: Build a small calculator`).test(line.text), at + 'the line says what happened to which task: ' + line.text);
            assert.ok(!/coral-board|run '|to start/i.test(line.text + line.title + line.all), at + 'no agent instruction is shown or in its tooltip: ' + JSON.stringify(line));
            assert.ok(line.link, at + 'the task number is a link');
            await ev(`document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(`/team/${board}/tasks/${id}`)}`, at + 'the task opens', 10000);
        }
        console.log('\nPASS A board queue line says what happened and opens its task');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
