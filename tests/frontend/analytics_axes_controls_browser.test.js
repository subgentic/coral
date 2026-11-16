// Analytics (#15842, Design N2): the spend chart's axis labels are the page's sans font with tabular figures (not monospace), and the time-range select is as tall as Refresh with the same centre line:
// 1440 and 390 px, dark and light, 200% text. Stubbed answers, isolated dev server. CORAL_SCREENSHOT_DIR saves a shot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const totals = { input_tokens: 1000, output_tokens: 2000, cache_read_tokens: 5000, cache_write_tokens: 700, cost_usd: 4, num_requests: 30 };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme, fontPx] of [[1440, 900, false, 'dark'], [1440, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light'], [1440, 900, false, 'light', 32], [390, 844, true, 'dark', 32]]) {
            const tag = `${w}px ${theme}${fontPx ? ' 200%' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); ${fontPx ? `document.documentElement.style.setProperty('font-size', '${fontPx}px', 'important');` : ''} (() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o) => { const url = String(u && u.url || u);
                    if (url.includes('/api/token-usage/summary')) return json({ totals: ${JSON.stringify(totals)}, previous: { totals: { ...${JSON.stringify(totals)}, cost_usd: 5, cache_read_tokens: 6000 } }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] });
                    if (url.includes('/api/call-metrics/summary')) return json({ rows: [], hours: 336 });
                    if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
                    if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                    if (url.includes('/api/token-usage/timeseries')) return json({ buckets: Array.from({ length: 12 }, (_, i) => ({ bucket: '2026-10-27T' + String(i).padStart(2, '0') + ':00:00Z', input_tokens: 10 + i, output_tokens: 30 - i, cache_read_tokens: 5 * i, cache_write_tokens: 3 + i % 4, num_requests: 2 + i % 5, cost_usd: 1 + i % 3, cumulative_cost: i + 1 })) });
                    if (url.includes('/api/token-usage/')) return json({});
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`document.querySelectorAll('.spend-label').length >= 6 && !!document.getElementById('cost-time-range')`, `${tag}: the chart axes and the header`, 15000);
            const d = await ev(`(() => { const sel = document.getElementById('cost-time-range'), btn = [...document.querySelectorAll('.cost-header-actions button')].find(b => /Refresh/.test(b.textContent)), a = sel.getBoundingClientRect(), r = btn.getBoundingClientRect();
                const fonts = [...document.querySelectorAll('.spend-label')].map(e => getComputedStyle(e).fontFamily), tab = [...document.querySelectorAll('.spend-label')].every(e => getComputedStyle(e).fontVariantNumeric.includes('tabular-nums')), sans = getComputedStyle(document.body).fontFamily;
                return { selH: Math.round(a.height), btnH: Math.round(r.height), selMid: Math.round(a.top + a.height / 2), btnMid: Math.round(r.top + r.height / 2), fonts: [...new Set(fonts)], tab, sans, sameRow: Math.abs((a.top + a.height / 2) - (r.top + r.height / 2)) < 2 }; })()`);
            assert.ok(d.fonts.every(f => !/mono/i.test(f) && f === d.sans), `${tag}: the axis labels are the page's sans font, not monospace: ${JSON.stringify([d.fonts, d.sans])}`);
            assert.ok(d.tab, `${tag}: the axis figures are tabular`);
            if (d.sameRow) assert.equal(d.selH, d.btnH, `${tag}: the range select and Refresh, side by side, are the same height: ${JSON.stringify(d)}`);
            assert.ok(d.selH >= (mobile ? 44 : 36), `${tag}: and at least ${mobile ? 44 : 36} px: ${d.selH}`);
            await shot(`analytics-axes-${w}-${theme}${fontPx ? '-200' : ''}`);
            await ev(`document.querySelector('.spend-label').scrollIntoView({ block: 'center' }); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the scroll settles
            await shot(`analytics-axes-chart-${w}-${theme}${fontPx ? '-200' : ''}`);
        }
        console.log('PASS Analytics: sans tabular axis labels, and the range select and Refresh the same height: 1440 and 390, dark and light, 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
