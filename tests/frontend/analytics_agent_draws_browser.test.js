// Analytics By agent draws its chart once per switch (#9450, from the #9086 run 3 report: the switch spent 268 of its 365 ms in long tasks): the table's draw ended with the chart's and the refresh drew it first as well, so every
// switch laid the page out twice for the chart's width and built the chart twice. The view is switched on a page whose reads are stand-ins of the report's size (30 agents, 300 sessions, a week of hourly series); the SVGs the chart
// panel gets are counted. The data table settles its fold from the observer, not from a second read of its width: no forced layout of a box not yet laid out (the fonts-ready call).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const real = window.fetch; const agents = Array.from({ length: 30 }, (_, i) => 'agent-' + i);
            const sess = Array.from({ length: 300 }, (_, i) => ({ session_id: 's' + i, agent_name: agents[i % 30], board_name: 'team-' + (i % 5), folder: '/repo/' + (i % 7), working_dir: '/repo/' + (i % 7), requests: 50 + i, input_tokens: 1e6 + i * 1000, output_tokens: 1e5 + i, cache_read_tokens: 5e6, cache_write_tokens: 1e5, cost_usd: 1 + i / 10, first_seen: new Date(Date.now() - 86400000).toISOString(), last_seen: new Date().toISOString() }));
            window.fetch = function (u, o) { const url = typeof u === 'string' ? u : u.url; const ok = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/token-usage\\/summary/.test(url)) return ok({ totals: { input_tokens: 1e9, output_tokens: 1e8, cache_read_tokens: 5e9, cache_write_tokens: 1e8, num_requests: 40000, cost_usd: 1234 }, by_agent: sess, by_agent_type: [], by_model: [], by_thinking: [] });
                if (/\\/api\\/token-usage\\/timeseries/.test(url)) { const m = /interval=(\\w+)/.exec(url), iv = m ? m[1] : '1h', step = iv === '1d' ? 86400000 : iv === '5m' ? 300000 : 3600000, n = iv === '1d' ? 30 : 168, grp = /group_by=agent/.test(url);
                    return ok({ buckets: Array.from({ length: n }, (_, i) => ({ bucket: new Date(Math.floor((Date.now() - (n - i) * step) / step) * step).toISOString(), input_tokens: 1e6, output_tokens: 1e5, cache_read_tokens: 5e6, cache_write_tokens: 1e4, cost_usd: 3, num_requests: 40, series: grp ? agents.map((a, k) => ({ key: a, input_tokens: 4e4, output_tokens: 4e3, cache_read_tokens: 2e5, cache_write_tokens: 400, cost_usd: 0.1 + ((i * 7 + k) % 5) / 10, num_requests: 3 })) : [] })) }); }
                return real.apply(this, arguments); }; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-by-agent tr.dt-row').length > 5`, 'the overview data', 20000);
        await ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = 'week'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await new Promise(r => setTimeout(r, 5000)); // sleep-ok: the overview's reads and redraws for the period settle (the page's own refreshes), so only the switch is counted
        await ev(`(() => { window.__svgs = 0; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches?.('svg.viz-svg')) window.__svgs++; }).observe(document.getElementById('cost-series-agent'), { childList: true, subtree: true }); return true; })()`);
        await ev(`import(${S} + 'analytics_views.js').then(m => { m.selectView('agent'); return true; })`);
        await waitFor(`document.querySelectorAll('#cost-series-agent svg.viz-svg').length >= 1 && document.querySelectorAll('#cost-by-agent tr.dt-row').length > 5`, 'the chart and the table of By agent', 15000);
        await new Promise(r => setTimeout(r, 1200)); // sleep-ok: a second draw, if there were one, comes after the first
        const draws = await ev(`window.__svgs`);
        assert.equal(draws, 1, 'the chart is drawn once for the switch, not once for the refresh and again for the table: ' + draws);
        console.log('PASS analytics agent draws: the By agent chart is drawn once per switch');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
