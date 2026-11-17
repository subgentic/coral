// Analytics (walk 80 #17, #18, #17696): a range with under an hour of data does not show "$2.14/hr" for $2.14 spent in ten minutes (that read as the total): it says "$2.14 so far" and why on hover;
// a chart that covers a whole day does not label both ends with the same clock time: each end carries its date. Isolated dev server, the summary and timeseries stubbed in the page; 1440 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const stub = buckets => `(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o) => { const url = String(u && u.url || u);
        if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 1, output_tokens: 1, cost_usd: 2.14 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] });
        if (url.includes('/api/token-usage/timeseries')) return json({ buckets: ${JSON.stringify(buckets)} });
        if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
        if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
        if (url.includes('/api/token-usage/')) return json({});
        return R(u, o); }; })();`;
const short = [{ bucket: '2026-11-16T00:40:00Z', cost_usd: 0.5, cumulative_cost: 0.5 }, { bucket: '2026-11-16T00:50:00Z', cost_usd: 1.64, cumulative_cost: 2.14 }];
const day = Array.from({ length: 25 }, (_, i) => ({ bucket: new Date(Date.UTC(2026, 10, 15, 1 + i)).toISOString(), cost_usd: i === 24 ? 2.14 : 0, cumulative_cost: i === 24 ? 2.14 : 0.0001 * i }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const [name, buckets] of [['short', short], ['day', day]]) {
            const { identifier } = await Page.addScriptToEvaluateOnNewDocument({ source: stub(buckets) });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`!!document.querySelector('#cost-spend-chart svg, #cost-burn-rate') && document.getElementById('cost-burn-rate').textContent.trim() !== '$0.00/hr'`, `${name}: the Analytics page`, 10000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the cards and chart are drawn after the reads settle
            const g = await ev(`({ burn: document.getElementById('cost-burn-rate').textContent.trim(), title: document.getElementById('cost-burn-rate').title, labels: [...document.querySelectorAll('#cost-spend-chart svg text.spend-label')].map(t => t.textContent.trim()) })`);
            if (name === 'short') {
                if (!/so far$/.test(g.burn) || /\/hr/.test(g.burn)) failures.push(`${name}: under an hour of data says "so far", not a rate per hour: ` + JSON.stringify(g));
                if (!/hourly rate/.test(g.title)) failures.push(`${name}: hover says why: ` + JSON.stringify(g));
            } else {
                const x = g.labels.slice(-3);
                if (x[0] === x[2] || !/\d/.test(x[0]) || !/[A-Za-z]/.test(x[0])) failures.push(`${name}: a whole day's two ends are not the same clock time, each has its date: ` + JSON.stringify(g));
            }
            await Page.removeScriptToEvaluateOnNewDocument({ identifier });
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('cost_burn_axis_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
