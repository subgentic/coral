// An ended agent that holds an open task stops the team being "All well" (#15293, walk 17 H1): nothing else said the task waited for an agent that was gone. An ended agent with no task still is not one that needs
// a person (#8269, team_agents_ended_browser). The board's /status answer is stubbed: one free agent, one ended agent, with and without an open task. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-endtask-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const open of [0, 1]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, availability, reason, open) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason, tasks: [], open_tasks: open });
                    const agents = [a('Free One', 'available', 'Idle', 0), a('Gone One', 'offline', 'No registered local session', ${open})];
                    return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 2, available: 1, offline: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM); await settle(800);
            const head = await ev(`(document.getElementById('team-page-status') || {}).textContent`);
            if (open) assert.match(head, /^1 needs attention$/, 'an ended agent that holds a task counts: ' + head);
            else assert.doesNotMatch(head, /need/, 'an ended agent with no task is not one that needs a person: ' + head);
        }
        console.log('PASS an ended agent holding a task makes the team header say "1 needs attention"; one with no task does not');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
