// Analytics' day buckets are UTC days (the route's strftime('%Y-%m-%dT00:00:00Z')), so the date the page prints for a daily bucket is the bucket's UTC date, whatever the browser's time zone (#9511, found by comparing the
// page with its routes): in Los Angeles the bucket of 2026-10-21 (00:00Z) used to be drawn as "Oct 20", the evening before, and the morning's usage of Oct 21 was read as Oct 20's. The cumulative spend chart's axis (a month
// range reads 1d buckets) and the series charts' axes and tooltips are asserted in America/Los_Angeles, Pacific/Auckland and UTC. The Overview cards are read against the summary's totals too (the units and the
// rounding: 1.2M, 2.5K, 999.4K, a whole request count, cents; and the empty summary: 0 and $0.00). 1280 px, the routes stubbed with fixed buckets. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const DAYS = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 9, 19 + i)).toISOString()); // 2026-10-19T00:00:00.000Z ... 2026-10-25
const usUtc = iso => new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const STUB = `(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o) => { const url = String(u && u.url || u), p = new URL(url, location.origin);
        if (url.includes('/api/token-usage/summary')) return json({ totals: window.__totals || { input_tokens: 10, output_tokens: 20, cost_usd: 4 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] });
        if (url.includes('/api/token-usage/timeseries')) { window.__tsReq = (window.__tsReq || []).concat(url); const days = ${JSON.stringify(DAYS)}; let cum = 0;
            return json({ interval: p.searchParams.get('interval'), buckets: days.map((d, i) => { cum += 2 + i; return { bucket: d, cost_usd: 2 + i, cumulative_cost: cum, input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, num_requests: 3 }; }) }); }
        if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
        if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
        if (url.includes('/api/token-usage/')) return json({});
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
            await Emulation.setTimezoneOverride({ timezoneId: tz });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`!!document.getElementById('cost-time-range')`, `${tz}: the range select`, 10000);
            await ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = 'month'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`(window.__tsReq || []).some(u => /interval=1d/.test(u)) && document.querySelectorAll('.spend-chart-svg text.spend-label').length >= 5`, `${tz}: the month's daily chart`, 10000);
            const labels = await ev(`[...document.querySelectorAll('.spend-chart-svg text.spend-label')].map(t => t.textContent.trim()).filter(t => /[A-Za-z]{3} \\d/.test(t))`);
            await shot('day-buckets-' + tz.replace('/', '-'));
            assert.deepEqual(labels, [usUtc(DAYS[0]), usUtc(DAYS[3]), usUtc(DAYS[6])], `${tz}: the axis names the UTC days of the first, middle and last bucket, not the browser's day of their start`);
            const series = await ev(`import((window.__coralStatic || '/static/') + 'analytics_series.js').then(m => [m.timeLabel(Date.UTC(2026, 9, 21), '1d'), m.timeLabel(Date.UTC(2026, 9, 21, 23), '1d')])`);
            assert.deepEqual(series, [usUtc(DAYS[2]), usUtc(DAYS[2])], `${tz}: a series chart's axis and tooltip name a day bucket by its UTC date`);
            console.log(`${tz}: ok`);
        }
        // the cards against the route's totals: units and rounding, then the empty state
        const cards = () => ev(`Object.fromEntries(['cost-input-tokens', 'cost-output-tokens', 'cost-cache-read', 'cost-cache-write', 'cost-total-requests', 'cost-total-cost'].map(id => [id, document.getElementById(id).textContent.trim()]))`);
        const refresh = async totals => { await ev(`window.__totals = ${JSON.stringify(totals)}; import((window.__coralStatic || '/static/') + 'cost_dashboard.js').then(m => m._refreshCostDashboard({ force: true })).then(() => true)`); };
        await refresh({ input_tokens: 1234567, output_tokens: 2500, cache_read_tokens: 999400, cache_write_tokens: 0, num_requests: 1234, cost_usd: 12.345 });
        await waitFor(`document.getElementById('cost-input-tokens').textContent.trim() === '1.2M'`, 'the cards after the refresh', 8000);
        assert.deepEqual(await cards(), { 'cost-input-tokens': '1.2M', 'cost-output-tokens': '2.5K', 'cost-cache-read': '999.4K', 'cost-cache-write': '0', 'cost-total-requests': '1234', 'cost-total-cost': '$12.35' }, 'the cards say the totals: compact tokens to one decimal, a whole request count, cents');
        await refresh({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, num_requests: 0, cost_usd: 0 });
        await waitFor(`document.getElementById('cost-input-tokens').textContent.trim() === '0'`, 'the empty cards', 8000);
        assert.deepEqual(await cards(), { 'cost-input-tokens': '0', 'cost-output-tokens': '0', 'cost-cache-read': '0', 'cost-cache-write': '0', 'cost-total-requests': '0', 'cost-total-cost': '$0.00' }, 'an empty summary reads 0 and $0.00, not blank or NaN');
        console.log('analytics_day_buckets_tz_browser: ok');
        process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
})();
