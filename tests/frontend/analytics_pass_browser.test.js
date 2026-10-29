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
            if (url.includes('/api/call-metrics/summary')) return json({ rows: [], hours: 336 }); // the server keeps calls 14 days
            if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/timeseries')) return json({ buckets: Array.from({ length: 12 }, (_, i) => ({ bucket: '2026-10-27T' + String(i).padStart(2, '0') + ':00:00Z', cost_usd: 1 + i % 3, cumulative_cost: i + 1 })) });
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
        await waitFor(`!document.getElementById('cost-counts-note').hidden && document.getElementById('cost-counts-note').textContent !== ''`, 'the counts note and its sentence (the Overview un-hid the note before the data came, #10979)', 8000);
        assert.equal(await ev(`document.getElementById('cost-counts-note').textContent`), 'Nothing counted in this range. Spend counts the agents Coral has run; a chat you ran outside Coral is not included.');
        await open({ input_tokens: 10, output_tokens: 20, cost_usd: 4, num_requests: 3 });
        await waitFor(`document.getElementById('cost-total-cost').textContent === '$4.00'`, 'the range\'s cost', 8000);
        assert.equal(await ev(`document.getElementById('cost-counts-note').hidden`), true, 'with something counted the note is gone');
        // 2. Total cost is the first card, with today and this month beside it (whatever the range)
        assert.equal(await ev(`document.querySelector('#cost-summary-cards .cost-card .cost-card-label').textContent.trim()`), 'Total cost', 'Total cost comes first');
        await waitFor(`document.getElementById('cost-calendar-cost').textContent !== ''`, 'today and this month', 8000);
        assert.equal(await ev(`document.getElementById('cost-calendar-cost').innerText.replace(/\\s+/g, ' ').trim()`), 'Today $1.50 This month $7.00');
        assert.equal(await ev(`document.querySelectorAll('#cost-calendar-cost span').length`), 2, 'a line each: Today, This month');
        assert.equal(await ev(`document.getElementById('cost-total-cost').textContent`), '$4.00', 'and the card still shows the range\'s cost');
        // the line does not run into the sparkline, at the three widths the cards wrap at (#10521, review)
        for (const [w, h, mobile] of [[1280, 900, false], [1024, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await open({ input_tokens: 10, output_tokens: 20, cost_usd: 4, num_requests: 3 });
            await waitFor(`document.getElementById('cost-calendar-cost').textContent !== '' && !!document.querySelector('#cost-spark-cost svg')`, `${w}: today, this month and the sparkline`, 10000);
            const g = await ev(`(() => { const c = document.querySelector('.cost-card-highlight'), cal = document.getElementById('cost-calendar-cost').getBoundingClientRect(), sp = document.querySelector('#cost-spark-cost svg').getBoundingClientRect(), box = c.getBoundingClientRect(); const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; return { overlap: hit(cal, sp), calInside: cal.left >= box.left && cal.right <= box.right && cal.bottom <= box.bottom + 1, spInside: sp.bottom <= box.bottom + 1 }; })()`);
            assert.equal(g.overlap, false, `${w}: Today and This month do not touch the sparkline ${JSON.stringify(g)}`);
            assert.ok(g.calInside && g.spInside, `${w}: both are inside the card ${JSON.stringify(g)}`);
        }
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        // a read that arrives while another view is open does not un-hide the Overview's note (#10988); coming back shows it again
        await open({ input_tokens: 0, output_tokens: 0, cost_usd: 0, num_requests: 0 });
        await waitFor(`!document.getElementById('cost-counts-note').hidden && document.getElementById('cost-counts-note').textContent !== ''`, 'the note on the Overview', 8000);
        await ev(`(async () => { const v = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); v.selectView('agent'); const c = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); window.__asks0 = window.__summaryAsks.length; await c._refreshCostDashboard({ force: true }); return true; })()`);
        await waitFor(`window.__summaryAsks.length > window.__asks0`, 'a read while By agent is open', 8000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the answer is drawn
        assert.equal(await ev(`document.getElementById('cost-counts-note').hidden`), true, 'a read while another view is open leaves the Overview\'s note hidden');
        await ev(`(async () => { (await import((window.__coralStatic || '/static/') + 'analytics_views.js')).selectView('overview'); return true; })()`);
        assert.equal(await ev(`document.getElementById('cost-counts-note').hidden`), false, 'the note is back when the Overview is');
        // the note never sits beside a total: money or tokens counted with no request recorded
        await open({ input_tokens: 10, output_tokens: 20, cost_usd: 4, num_requests: 0 });
        await waitFor(`document.getElementById('cost-total-cost').textContent === '$4.00'`, 'the cost', 8000);
        assert.equal(await ev(`document.getElementById('cost-counts-note').hidden`), true, 'a cost with no request count has no "Nothing counted" note');
        // and an empty note is not drawn as an empty box when the Overview opens again (#10979: the view switcher un-hid it whatever it had to say)
        await ev(`(async () => { const v = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); v.selectView('agent'); v.selectView('overview'); return true; })()`);
        assert.equal(await ev(`(() => { const n = document.getElementById('cost-counts-note'); return n.hidden || n.getClientRects().length === 0; })()`), true, 'the note with nothing to say is not an empty box on the Overview');
        // 3. an empty range says to try a longer one, except the longest
        await open({ input_tokens: 0, output_tokens: 0, cost_usd: 0, num_requests: 0 });
        const empty = () => ev(`document.getElementById('cost-dashboard-view').textContent`);
        await waitFor(`/It appears once an agent has done some work/.test(document.getElementById('cost-dashboard-view').textContent)`, 'an empty-state line', 10000);
        assert.match(await empty(), /try a longer range/, 'a day with nothing says to try a longer range');
        await ev(`(() => { const sel = document.getElementById('cost-time-range'); sel.value = 'month'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`!/try a longer range/.test(document.getElementById('cost-dashboard-view').textContent)`, 'the longest range without the hint', 10000);
        assert.match(await empty(), /It appears once an agent has done some work\./, 'but still says what makes data appear');
        // 4. Tool and API calls (Coral's own routes) is under Advanced, and its 14-day keep is said in the range's words
        const names = () => ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].map(b => b.textContent.trim())`);
        assert.deepEqual(await names(), ['Overview', 'Tokens per commit', 'Task time', 'Advanced'], 'the list has three views and Advanced');
        assert.equal(await ev(`document.querySelector('#cost-nav-list [data-on-click="analytics-advanced"]').getAttribute('aria-expanded')`), 'false');
        await ev(`(() => { const b = document.querySelector('#cost-nav-list [data-on-click="analytics-advanced"]'); b.focus(); b.click(); return true; })()`);
        await waitFor(`[...document.querySelectorAll('#cost-nav-list .row-btn')].some(b => b.textContent.trim() === 'Tool and API calls')`, 'the advanced view', 8000);
        assert.deepEqual(await names(), ['Overview', 'Tokens per commit', 'Task time', 'Advanced', 'Tool and API calls']);
        assert.equal(await ev(`document.activeElement && document.activeElement.textContent.trim()`), 'Advanced', 'the keyboard stays on Advanced');
        await ev(`document.querySelector('#cost-nav-list [data-view="calls"]').click(); true`);
        await waitFor(`/last 14 days/.test(document.getElementById('call-metrics-summary').textContent)`, 'the calls say what they keep', 10000);
        assert.match(await ev(`document.getElementById('call-metrics-summary').textContent`), /Calls are kept for 14 days, so this shows the last 14 days, not the last 30 days\./);
        console.log('PASS analytics_pass');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
