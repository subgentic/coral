// #20019 (Inbox walk #20009 item 8): a new team that requires a goal for every task (a planning-approval choice sets it), launched with a first task NOT saved as the team's goal, showed the red toast "The team
// started, but the first task was not added to its Tasks tab": the board refused the task (goal_required). The goal is now made after all and the task goes in under it. The isolated dev server, a board made
// through the API, _openLaunchedTeam as Launch team calls it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const BOARD = 'team-first-task-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        assert.equal(await ev(`fetch('/api/board/${BOARD}/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', require_goal: true }) }).then(r => r.status)`), 200, 'the team requires a goal for every task');
        await ev(`window.__tasks = []; { const R = window.fetch; window.fetch = async (u, o = {}) => { const r = await R(u, o); if (new URL(String(u), location.href).pathname === '/api/board/${BOARD}/tasks' && String(o.method).toUpperCase() === 'POST') window.__tasks.push(r.status); return r; }; } true`);
        await ev(`import(${S} + 'team_dialogs.js').then(m => m._openLaunchedTeam('local', ${JSON.stringify(BOARD)}, 'Build the importer. Then test it.', [{ name: 'Boss' }], Promise.resolve(), null, false)).then(() => true)`);
        await waitFor(`!!document.getElementById('team-page-view') && document.getElementById('team-page-view').getClientRects().length > 0`, 'the team page', 15000);
        await waitFor(`window.__tasks.length >= 1 && window.__tasks[window.__tasks.length - 1] === 201`, 'the first task is accepted in the end: ' + JSON.stringify(await ev('window.__tasks')), 10000);
        const tasks = await ev(`fetch('/api/board/${BOARD}/tasks').then(r => r.json())`);
        const mine = (Array.isArray(tasks) ? tasks : tasks.tasks || []).find(t => /Build the importer/.test(t.title));
        assert.ok(mine, 'the first task is on the Tasks tab: ' + JSON.stringify(tasks).slice(0, 300));
        assert.ok(mine.goal_id, 'it is listed under a goal, as the board requires: ' + JSON.stringify(mine).slice(0, 300));
        console.log('PASS the first task of a team that requires a goal goes in under one');
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
