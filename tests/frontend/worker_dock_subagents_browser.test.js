// A worker's Tasks dock lists the sub-agents that worker launched (#16016, the Operator's bug): #7780 (a221856fd) scoped a worker's dock to its own tasks and dropped the sub-agent rows with the board-wide ones,
// so on a team every worker's sub-agents were missing from Tasks. The rows are this agent's own work; the board-wide ones stay out. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            const T = window.T = { state: (await import(st + 'state.js')).state, tasks: await import(st + 'tasks.js') };
            T.state.currentSession = { name: 'dev', display_name: 'Dev', type: 'live', board_project: 'team-a', board_is_orchestrator: false, board_subscriber_id: 'Dev', session_id: 'sid' }; T.state.currentAgentTasks = [];
            T.state.currentSubagents = [['Explore the login code', 'sa1', 'completed'], ['Write the tests', 'sa2', 'in_progress']].map(([d, id, s], i) => ({ id: i + 1, subagent_id: id, session_id: 'sid', status: s, finished: s === 'completed', description: d, started_at: '2026-10-1' + i + 'T10:00:00Z' }));
            const real = window.fetch;
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href);
                if (p.pathname.startsWith('/api/board/') && p.pathname.endsWith('/tasks')) return Promise.resolve(new Response(JSON.stringify({ tasks: [{ id: 7, title: 'Fix login', status: 'in_progress', assigned_to: 'Dev' }, { id: 8, title: 'Somebody else', status: 'pending', assigned_to: 'QA' }], next_cursor: '', total_open: 2, total_completed: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return real(u, o); };
            await T.tasks.loadBoardTasks('team-a'); return true; })()`);
        await waitFor(`[...document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)')].some(e => e.dataset.subagentId === 'sa2')`, 'the worker\'s sub-agent rows');
        const rows = await ev(`[...document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)')].map(e => ({ sub: e.dataset.subagentId || '', text: e.textContent.replace(/\\s+/g, ' ').trim() }))`);
        assert.deepEqual(rows.filter(r => r.sub).map(r => r.sub).sort(), ['sa1', 'sa2'], 'both sub-agents are in the worker\'s Tasks: ' + JSON.stringify(rows));
        assert.ok(rows.some(r => /Fix login/.test(r.text)), 'its own board task is there');
        assert.ok(!rows.some(r => /Somebody else/.test(r.text)), 'the board-wide task of another member stays out');
        console.log('PASS a worker\'s Tasks lists its sub-agents');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
