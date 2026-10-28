// The running-total chart's money axis has no repeated tick and two agents' end labels do not overlap (#10740, Desktop #10737): with totals of about $0.019 the axis steps were $0.005, $0.01, $0.015, $0.02 and read "$0.0050, $0.01, $0.01, $0.02";
// the ticks now show as many decimals as it takes to tell them apart. Two lines that end within a cent of each other keep their labels apart. 1280 px, stubbed answers; isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const MOD = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            const hours = Array.from({ length: 24 }, (_, h) => new Date(Date.now() - (23 - h) * 3600000).toISOString().replace(/:\\d\\d:\\d\\d\\.\\d+Z$/, ':00:00Z'));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10, output_tokens: 20, cost_usd: 0.0375, num_requests: 4 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [
                    { session_id: 'a', agent_name: 'Frontend Dev', board_name: 't', folder: 'c', requests: 2, input_tokens: 5, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.019, first_seen: '2026-10-27T00:00:00Z', last_seen: '2026-10-27T01:00:00Z' },
                    { session_id: 'b', agent_name: 'QA Engineer', board_name: 't', folder: 'c', requests: 2, input_tokens: 5, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.0185, first_seen: '2026-10-27T00:00:00Z', last_seen: '2026-10-27T01:00:00Z' }] });
                if (url.includes('/api/token-usage/timeseries')) return json({ buckets: hours.map(b => ({ bucket: b, cost_usd: 0.0015625, series: [{ key: 'Frontend Dev', label: 'Frontend Dev', cost_usd: 0.019 / 24, num_requests: 1 }, { key: 'QA Engineer', label: 'QA Engineer', cost_usd: 0.0185 / 24, num_requests: 1 }] })) });
                if (url.includes('/api/call-metrics/summary')) return json({ rows: [] });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.getElementById('cost-total-cost').textContent !== '$0.00'`, 'the summary', 15000);
        await ev(`import(${MOD} + 'analytics_views.js').then(m => { m.selectView('agent'); return true; })`);
        await waitFor(`document.querySelectorAll('#cost-series-agent .viz-svg path.viz-line').length === 2`, 'the two lines', 10000);
        await sleep(500); /* sleep-ok: the chart finishes drawing */
        const got = await ev(`(() => { const svg = document.querySelector('#cost-series-agent .viz-svg'); const money = [...svg.querySelectorAll('text.viz-axis')].map(t => t.textContent.trim()).filter(t => t.startsWith('$')); const ends = [...svg.querySelectorAll('text.viz-end')].map(t => { const r = t.getBoundingClientRect(); return { text: t.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom) }; }).sort((a, b) => a.top - b.top); return { money, ends }; })()`);
        assert.equal(new Set(got.money).size, got.money.length, `no repeated tick on the money axis: ${JSON.stringify(got.money)}`);
        assert.equal(got.ends.length, 2, `two end labels: ${JSON.stringify(got.ends)}`);
        assert.ok(got.ends[1].top >= got.ends[0].bottom, `the end labels do not overlap: ${JSON.stringify(got.ends)}`);
        console.log('PASS chart ticks');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
