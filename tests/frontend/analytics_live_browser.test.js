// "Live" on Analytics says the numbers follow the server (#10740, Desktop #10737): while the page is open its figures are read again every 15 seconds, and a figure that grew is drawn again: Total cost, Requests and the cards. Stubbed answers
// that grow with each read; isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.__reads = 0; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (/\\/api\\/token-usage\\/summary\\?since=/.test(url) && !/since=.*T00%3A00%3A00/.test(url) || /\\/api\\/token-usage\\/summary$/.test(url)) { const n = ++window.__reads; return json({ totals: { input_tokens: 1000 * n, output_tokens: 100 * n, cost_usd: 1 + n, num_requests: 10 * n }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] }); }
                if (url.includes('/api/call-metrics/summary')) return json({ rows: [], hours: 336 });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                if (url.includes('/api/token-usage/timeseries')) return json({ buckets: [] });
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.getElementById('cost-total-requests').textContent !== '0'`, 'the first read', 15000);
        const first = await ev(`({ req: document.getElementById('cost-total-requests').textContent, cost: document.getElementById('cost-total-cost').textContent, reads: window.__reads })`);
        await waitFor(`window.__reads > ${first.reads}`, 'a second read (15 s)', 25000);
        await waitFor(`document.getElementById('cost-total-requests').textContent !== ${JSON.stringify(first.req)}`, 'the figures drawn again', 5000);
        const word = () => ev(`document.getElementById('cost-live-text').textContent`);
        assert.match(await word(), /^Updated \d\d?:\d\d:\d\d/, 'the indicator says when the figures were read, not that they are "Live"');
        const later = await ev(`({ req: document.getElementById('cost-total-requests').textContent, cost: document.getElementById('cost-total-cost').textContent })`);
        assert.notEqual(later.cost, first.cost, 'Total cost follows');
        assert.doesNotMatch(await ev(`document.getElementById('cost-range-line').textContent`), /\bLive\b/, 'no "Live" word on the range line');
        console.log('PASS analytics live');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
