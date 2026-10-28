// One count, the same words, for the same sleeping agents (#10246, left from #10164): after a Coral restart three of a team's agents are asleep. The sidebar group's folded row and the team page's Agents tab chip both lead with
// "3 sleeping" / "Sleeping 3"; the sidebar adds that they came back asleep after Coral restarted. The mocked live list and the stubbed board status describe the same three agents. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-asleep-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => {
            window.__m.add('lead', 'L', 2, { sleeping: false, board_project: ${JSON.stringify(TEAM)} });
            for (const n of ['dev-a', 'dev-b', 'dev-c']) window.__m.add(n, n, 2, { sleeping: true, sleep_reason: 'coral_stopped', board_project: ${JSON.stringify(TEAM)} });
            window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
        await waitFor(`!!document.querySelector('#live-sessions-list .sleeping-summary-row .sleeping-summary-label')`, 'the sidebar summary row', 8000);
        const side = await ev(`[...document.querySelectorAll('#live-sessions-list .sleeping-summary-row .sleeping-summary-label')].map(e => e.textContent.trim())`);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, availability, reason) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason, tasks: [] });
                const agents = [a('lead', 'available', 'Idle'), a('dev-a', 'sleeping', 'Asleep'), a('dev-b', 'sleeping', 'Asleep'), a('dev-c', 'sleeping', 'Asleep')];
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 4, available: 1, sleeping: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`[...document.querySelectorAll('.goals-chip')].some(c => /Sleeping/.test(c.textContent))`, 'the Sleeping chip', 8000);
        const chips = await ev(`[...document.querySelectorAll('.goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
        const chip = chips.find(c => /^Sleeping/.test(c));
        assert.match(chip, /^Sleeping 3$/, 'the chip says Sleeping 3: ' + JSON.stringify(chips));
        assert.ok(side.some(t => /^3 sleeping agents\b/.test(t)), 'the sidebar leads with the same count and word: ' + JSON.stringify(side));
        assert.ok(side.some(t => /after Coral restarted/.test(t)), 'and still says they came back asleep after Coral restarted: ' + JSON.stringify(side));
        console.log('PASS the sidebar and the Agents tab say the same about the same three sleeping agents');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
