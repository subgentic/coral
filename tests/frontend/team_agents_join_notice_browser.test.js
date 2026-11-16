// #17343: the team page's Agents row says whether the Orchestrator was told of an agent added to the team: "Team told" once it has read the notice, "Team not told yet" before (or with no Orchestrator), and nothing once the agent
// has a task. The board's /status answer is stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, liveWaiting } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-joined-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await liveWaiting(ev);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, extra) => Object.assign({ name, subscriber_id: name, agent_type: 'claude', availability: 'available', available: true, reason: 'Idle', tasks: [] }, extra);
                const agents = [a('Told One', { join_notice: 'told' }), a('Untold One', { join_notice: 'not_told' }), a('Old Hand', {})];
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 3, available: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(600);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 3`, 'the three agents', 8000);
        const doing = await ev(`(() => { const o = {}; for (const r of document.querySelectorAll('tr.dt-row')) { const n = ['Told One', 'Untold One', 'Old Hand'].find(x => r.innerText.includes(x)); if (n) o[n] = r.innerText; } return o; })()`);
        assert.match(doing['Told One'], /Team told/, 'a read notice says the team was told: ' + doing['Told One']);
        assert.match(doing['Untold One'], /Team not told yet/, 'an unread one says not told yet: ' + doing['Untold One']);
        assert.ok(!/Team (not )?told/.test(doing['Old Hand']), 'an agent that was not added through Add agent says nothing: ' + doing['Old Hand']);
        console.log('PASS the Agents row says whether the team was told of a new agent');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
