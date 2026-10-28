// Cost rows that round to the same cents show more precision (#10740, Desktop #10737): two models that cost $1.2312 and $1.2349 are both "$1.23" at two decimals, which reads as a tie; the column then shows three decimals ($1.231, $1.235),
// and a column whose rows already differ at the cent stays at two ($2.50, $0.40). Stubbed answers; isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const row = (model, cost) => ({ model, agent_type: 'claude', num_sessions: 1, input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const costs = async (models) => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 300, output_tokens: 30, cost_usd: 4, num_requests: 3 }, by_model: ${JSON.stringify(models)}, by_thinking: [], by_agent_type: [], by_agent: [] });
                if (url.includes('/api/call-metrics/summary')) return json({ rows: [] });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                if (url.includes('/api/token-usage/timeseries')) return json({ buckets: [] });
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-by-model tbody tr').length === ${models.length}`, 'the model rows', 15000);
        return ev(`(() => { const h = [...document.querySelectorAll('#cost-by-model thead th')].findIndex(t => /^Cost/.test(t.textContent.trim())); return [...document.querySelectorAll('#cost-by-model tbody tr')].map(tr => tr.children[h].textContent.trim()); })()`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        const close = await costs([row('claude-opus-5-5', 1.2312), row('claude-sonnet-5-5', 1.2349), row('claude-haiku-5-5', 0.0042)]);
        assert.equal(new Set(close).size, 3, `three different costs read as three: ${JSON.stringify(close)}`);
        assert.ok(close.some(c => c === '$1.231') && close.some(c => c === '$1.235'), `the two that tied show three decimals: ${JSON.stringify(close)}`);
        const apart = await costs([row('claude-opus-5-5', 2.5), row('claude-sonnet-5-5', 0.4)]);
        assert.deepEqual([...apart].sort(), ['$0.40', '$2.50'], `rows that differ at the cent stay at cents: ${JSON.stringify(apart)}`);
        console.log('PASS cost precision');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
