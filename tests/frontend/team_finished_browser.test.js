// A team whose every task is done, with nothing open and nobody working, does not say "All well" like one still at it (#15304, walk 21 H2): it says "Finished: your turn". The board's /status and
// /tasks?counts=1 answers are stubbed: a free agent, and open/done task counts. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-finished-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const [open, done, want] of [[0, 3, 'Finished: your turn'], [1, 3, 'All well'], [0, 0, 'All well']]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            await ev(`(() => { const R = window.fetch.bind(window); const J = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (url.pathname === '/api/board/${TEAM}/status') return J({ agents: [{ name: 'Free One', subscriber_id: 'Free One', agent_type: 'claude', availability: 'available', available: true, reason: 'Idle', tasks: [], open_tasks: 0 }], summary: { total: 1, available: 1 } });
                    if (url.pathname === '/api/board/${TEAM}/tasks' && url.searchParams.get('counts')) return J({ tasks: [], next_cursor: '', total_open: ${open}, total_completed: ${done} });
                    return R(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM); await settle(1000);
            const head = await ev(`(document.getElementById('team-page-status') || {}).textContent.trim()`);
            assert.equal(head, want, `open ${open}, done ${done}: ${head}`);
        }
        console.log('PASS the header says "Finished: your turn" only when tasks are all done and none is open');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
