// #20000 (coral-hub #252972): on Coral Hub's page every computer is remote, and Operator interaction used to drop every board (spendTeamKeys), so no team was ever picked and /api/analytics/activity was
// never read ("No team has a board yet"). It now keeps the picked computer's teams: a team of the first computer is read through /api/remote/m1/, a pick of the second computer moves it to that computer's team.
// The stubbed two-computer Hub (helpers/hub_world), 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { window.__seen = []; const R = window.fetch.bind(window);
            const ok = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
            const BOARDS = { m1: 'alpha-team', m2: 'beta-team' };
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/.exec(url.pathname);
                if (m) { window.__seen.push(url.pathname + url.search);
                    if (m[2] === '/api/board/projects') return ok([{ board_id: BOARDS[m[1]] }]);
                    if (m[2] === '/api/analytics/activity') return ok({ range: '14d', activity: { total: 0, by_day: [], by_hour: [] } });
                    if (m[2] === '/api/token-usage/summary') return ok({ totals: { input_tokens: 1, output_tokens: 1, num_sessions: 1, num_requests: 1, cost_usd: 0.1 }, by_agent: [], by_model: [], by_agent_type: [] }); }
                return R(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await ev(`(async () => { const v = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); v.selectView('operator'); return true; })()`);
        await waitFor(`window.__seen.some(p => /^\\/api\\/remote\\/m1\\/api\\/analytics\\/activity\\?team=alpha-team&/.test(p))`, "the first computer's team is read through its tunnel", 10000);
        assert.ok(!/No team has a board yet/.test(await ev(`document.getElementById('cost-dashboard-view')?.textContent || document.body.textContent`)), 'the page does not say no team has a board');
        // a pick of the other computer: its team is read instead
        await ev(`window.__seen.length = 0; (() => { const p = document.getElementById('cost-computer-pick'); p.querySelector('.computer-bar-button').click(); p.querySelector('.computer-bar-option[data-computer="m2"]').click(); return true; })()`);
        await waitFor(`window.__seen.some(p => /^\\/api\\/remote\\/m2\\/api\\/analytics\\/activity\\?team=beta-team&/.test(p))`, "the pick moves the read to the second computer's team", 10000);
        assert.ok(!(await ev(`window.__seen`)).some(p => /\/m1\/api\/analytics\/activity/.test(p)), 'the first computer is not read again after the pick');
        console.log('PASS Hub Operator interaction reads the picked computer\'s team');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
