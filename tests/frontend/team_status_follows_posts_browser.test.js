// The team page's header follows the agents' first posts within seconds (#10589, Mobile recheck #10588): "2 of 3 waiting for first signal" stayed ~15 s after the third agent had posted online, because the status
// was read every 30 s. While an agent has not reported, the page reads it every 3 s (for the first two minutes on screen), then returns to the slow read. The team's board reads are stubbed in the page. 390 px, isolated
// dev server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = 'status-follow-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await installTP(ev); await seed(ev, TEAM);
        await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
        await ev(`window.__av = ['idle', 'idle', 'unknown']; { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname;
            if (p === '/api/board/${TEAM}/status') return Promise.resolve(new Response(JSON.stringify({ agents: window.__av.map((a, i) => ({ session_id: 'sid-' + (i + 1), subscriber_id: 'Agent ' + i, name: 'Agent ' + i, availability: a })) }), { headers: { 'Content-Type': 'application/json' } }));
            return real(u, o); }; } true`);
        await openTeam(ev, waitFor, TEAM);
        const status = () => ev(`(document.getElementById('team-page-status') || {}).textContent || ''`);
        await waitFor(`/waiting|of 3|first signal/i.test((document.getElementById('team-page-status') || {}).textContent || '')`, 'the status with one agent not yet reported', 10000)
        const before = await status();
        await ev(`window.__av = ['idle', 'idle', 'idle']; window.__flipped = performance.now(); true`);
        // the third agent has posted: the header says all well within a few seconds, not at the next 30 s read
        await waitFor(`/All well/.test((document.getElementById('team-page-status') || {}).textContent || '')`, 'All well after the third agent reported', 8000).catch(async () => problems.push(`the header follows the third agent's post within 8 s (it still says "${await status()}" after ${Math.round(await ev('performance.now() - window.__flipped') / 1000)} s; it said "${before}" before)`));
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the team header:\n  ' + problems.join('\n  '));
    console.log('PASS the team header follows the first posts within seconds');
})().catch(e => { console.error(e); process.exit(1); });
