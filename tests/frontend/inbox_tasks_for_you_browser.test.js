// Inbox > Tasks lists the tasks assigned to the Operator, and its empty state says exactly that (#10127, Beta Tester #10110: a new team had task #1 assigned to its Orchestrator, and Inbox > Tasks said "No assigned tasks. Tasks given
// to you or to your agents are listed here." with every count 0, as if the team's task were missing). The tasks of your agents are in each team's Tasks tab, and the empty state points there. A real board with a real task assigned to
// an Orchestrator, on the real page (agent_view_harness answers the lists with stand-ins). 1280 px, isolated dev server.
'use strict';
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const BOARD = `qa-forme-${Date.now() % 100000}`;

(async () => {
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        const call = (method, path, body) => ev(`fetch('/api/board/${BOARD}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
        assert.equal((await call('POST', '/subscribe', { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' })).status, 200, 'the Orchestrator joined the board');
        const made = await call('POST', '/tasks', { title: 'Say hello to the team', body: 'first task', created_by: 'Operator', assigned_to: 'Orchestrator' });
        assert.ok(made.status === 200 || made.status === 201, 'the task assigned to the Orchestrator exists: ' + JSON.stringify(made));
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelector('.top-nav-tab.active')?.dataset.arg === 'hub-inbox'`, 'the Inbox tab', { timeout: 8000 });
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view')?.dataset.group === 'hub-inbox:tasks'`, 'the Tasks folder', { timeout: 8000 });
        await waitFor(`document.getElementById('group-table-view')?.textContent.includes('Say hello to the team')`, 'agent task in the shared Inbox');
        const text = await ev(`document.getElementById('group-table-view').textContent`);
        assert.match(text, /Say hello to the team/, 'tasks assigned to agents are included');
        await ev(`[...document.querySelectorAll('#group-table-view button')].find(b => b.textContent.includes('Assigned to me')).click();true`);
        await waitFor(`!document.getElementById('group-table-view')?.textContent.includes('Say hello to the team')`, 'Assigned to me excludes agent task');
        console.log('PASS Inbox Tasks includes agent tasks; Assigned to me keeps the owner-only view');
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
