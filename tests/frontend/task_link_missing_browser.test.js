// #15198 (walk 9 L5): a "Task #N" link on the board whose task cannot be read (deleted, or not this team's) used to open nothing useful (an empty "Task details" box for a newcomer). It says so with a way back: since #15295 the one themed not-found view ("That task was not found: #77"), no longer a note in the task's own panel.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'task-gone-' + Date.now().toString(36), boards = [board];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' })).status, 200);
        const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'Orchestrator', title: 'Build a small calculator', body: 'x', priority: 'medium', assigned_to: 'Orchestrator' }); assert.ok(t.status < 300, JSON.stringify(t));
        await Page.navigate({ url: BASE + `/team/${board}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await waitFor(`!!document.querySelector('#mb-messages .mb-queue-run .mb-queue-task')`, 'the task link', 15000);
        await ev(`document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').dataset.taskId = '77'; document.querySelector('#mb-messages .mb-queue-run .mb-queue-task').click(); true`); // the line's task is one that cannot be read (deleted, or not this team's)
        await waitFor(`location.pathname === ${JSON.stringify(`/team/${board}/tasks/77`)}`, 'the task route', 10000);
        await new Promise(r => setTimeout(r, 1500)); // sleep-ok: a read that fails has nothing to wait for; a short pause shows what the page settles on
        const seen = await ev(`({ modal: [...document.querySelectorAll('dialog[open], .modal')].filter(m => getComputedStyle(m).display !== 'none' && m.offsetHeight).map(m => m.id + ':' + m.textContent.trim().slice(0, 80)), item: (() => { const v = document.getElementById('not-found-view'); return v && !v.hidden ? v.querySelector('.not-found-title').textContent.trim() : null; })(), tab: location.pathname })`);
        console.log(JSON.stringify(seen));
        assert.ok(seen.item && /Task #?77|no longer|could not|not found/i.test(seen.item) && /77/.test(seen.item), 'the place says which task it could not show: ' + JSON.stringify(seen));
        assert.deepEqual(seen.modal, [], 'no empty dialog: ' + JSON.stringify(seen.modal));
        console.log('\nPASS A task link whose task cannot be read says so');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
