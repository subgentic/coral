// Cumulative spend never says "Not enough data yet" while Total cost is above zero (#10740, Desktop #10737): with money spent but only one interval to draw it says so. With nothing spent it still says what makes data appear.
// Stubbed answers; isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const open = async (cost, buckets) => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10, output_tokens: 20, cost_usd: ${cost}, num_requests: ${cost ? 3 : 0} }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] });
                if (url.includes('/api/token-usage/timeseries')) return json({ buckets: ${JSON.stringify(buckets)} });
                if (url.includes('/api/call-metrics/summary')) return json({ rows: [] });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`!!document.getElementById('cost-spend-chart') && document.getElementById('cost-spend-chart').textContent.trim().length > 0`, 'the chart or its words', 15000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the reads settle
        return ev(`document.getElementById('cost-spend-chart').textContent.replace(/\\s+/g, ' ').trim()`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        const one = await open(4, [{ bucket: '2026-10-27T10:00:00Z', cost_usd: 4, cumulative_cost: 4 }]);
        assert.doesNotMatch(one, /Not enough data yet/, `money was spent (one interval): ${one}`);
        assert.match(one, /one interval/, `it says why there is no line: ${one}`);
        const none = await open(4, []);
        assert.doesNotMatch(none, /Not enough data yet/, `money was spent (no interval read): ${none}`);
        const zero = await open(0, []);
        assert.match(zero, /Not enough data yet/, `nothing spent: it still says what makes data appear: ${zero}`);
        console.log('PASS spend chart empty words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
