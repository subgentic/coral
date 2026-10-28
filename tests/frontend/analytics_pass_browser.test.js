// Analytics, the Desktop pass (#10521): a range with nothing counted says what Coral counts, never a bare 0; Total cost is the first card, with today and this month beside it; the longest range does not
// say "try a longer range"; Tool and API calls (Coral's own routes) is under Advanced, not a view of its own. 1280 px, stubbed answers, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    // totals by `since`: the page's range asks one, the Total cost card's Today and This month ask others
    const stub = totals => ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
        window.__summaryAsks = [];
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (url.includes('/api/token-usage/summary')) { window.__summaryAsks.push(url); const since = new Date(new URL(url, location.origin).searchParams.get('since')), n = new Date(), isDay = since.getTime() === new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(), isMonth = since.getTime() === new Date(n.getFullYear(), n.getMonth(), 1).getTime();
                return json({ totals: isDay ? { ...${JSON.stringify(totals)}, cost_usd: 1.5 } : isMonth ? { ...${JSON.stringify(totals)}, cost_usd: 7 } : ${JSON.stringify(totals)}, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] }); }
            if (url.includes('/api/call-metrics/summary')) return json({ rows: [] });
            if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/')) return json({});
            return R(u, o); }; return true; })()`);
    const open = async totals => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await stub(totals); await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`!!document.getElementById('cost-total-cost') && document.getElementById('cost-total-cost').textContent !== ''`, 'the summary cards', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        // 1. nothing counted: the zeros come with what is counted
        await open({ input_tokens: 0, output_tokens: 0, cost_usd: 0, num_requests: 0 });
        await waitFor(`!document.getElementById('cost-counts-note').hidden`, 'the counts note', 8000);
        assert.equal(await ev(`document.getElementById('cost-counts-note').textContent`), 'Nothing counted in this range. Spend counts the agents Coral has run; a chat you ran outside Coral is not included.');
        await open({ input_tokens: 10, output_tokens: 20, cost_usd: 4, num_requests: 3 });
        await waitFor(`document.getElementById('cost-total-cost').textContent === '$4.00'`, 'the range\'s cost', 8000);
        assert.equal(await ev(`document.getElementById('cost-counts-note').hidden`), true, 'with something counted the note is gone');
        // 2. Total cost is the first card, with today and this month beside it (whatever the range)
        assert.equal(await ev(`document.querySelector('#cost-summary-cards .cost-card .cost-card-label').textContent.trim()`), 'Total cost', 'Total cost comes first');
        await waitFor(`document.getElementById('cost-calendar-cost').textContent !== ''`, 'today and this month', 8000);
        assert.equal(await ev(`document.getElementById('cost-calendar-cost').textContent`), 'Today $1.50 \u00b7 This month $7.00');
        assert.equal(await ev(`document.getElementById('cost-total-cost').textContent`), '$4.00', 'and the card still shows the range\'s cost');
        console.log('PASS analytics_pass');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
