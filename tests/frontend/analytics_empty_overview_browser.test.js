// The Analytics Overview on a server that has recorded no usage (Beta Tester's second pass, #9955): Cost by team was a heading with nothing under it, and Cumulative spend said only "Not enough data". Both now say what makes data
// appear, in the sentence the tables below use. The page is the real one, shown a server with no token usage (see the stub below). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            // The server is shared by the suites of a shard (#4830), and an earlier suite's agent leaves a transcript the token poller reads, so a shard's server can hold usage: the page is shown a server that has recorded none (#18965; the same answers analytics_cost_precision gives)
            await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o) => { const url = String(u && u.url || u);
                    if (url.includes('/api/token-usage/summary')) return json({ totals: {}, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] });
                    if (url.includes('/api/token-usage/timeseries')) return json({ buckets: [] });
                    if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
                    if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('tokens'); true`);
            if (!mobile) { // a phone opens on Overview itself (#10064); a wide screen picks it from the list
                await waitFor(`document.querySelector('#cost-nav-list .row-btn[data-view="overview"]')?.getClientRects().length > 0`, 'the Analytics view list', 10000);
                await ev(`document.querySelector('#cost-nav-list .row-btn[data-view="overview"]').click(); true`);
            }
            await waitFor(`!!document.querySelector('#cost-spend-chart .empty-state') && !/Loading/.test(document.getElementById('cost-spend-chart').textContent) && !!document.querySelector('#cost-series-overview .empty-state')`, `${w}: both empty states`, 15000);
            const t = await ev(`({ team: document.getElementById('cost-series-overview').textContent.trim(), cumulative: document.getElementById('cost-spend-chart').textContent.trim() })`);
            assert.equal(t.team, 'No data in this range yet. It appears once an agent has done some work; try a longer range.', `${w}: Cost by team does not stay a bare heading`);
            assert.equal(t.cumulative, 'Not enough data yet. It appears once an agent has done some work; try a longer range.', `${w}: Cumulative spend says what makes the line appear`);
        }
        console.log('PASS analytics overview empty states');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
