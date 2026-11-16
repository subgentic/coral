// Analytics tiles (#15841, Design N1): every tile's sparkline is ONE colour (--viz-1; a colour of its own would read as a status), and no text of a tile runs over its sparkline: 1440 and 390 px,
// dark and light, and at 200% text. Stubbed answers, isolated dev server. CORAL_SCREENSHOT_DIR saves a shot of the tiles.
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
            await waitFor(`document.querySelectorAll('.cost-card-sparkline svg').length >= 5`, `${tag}: the tile sparklines`, 15000);
            const d = await ev(`(() => { const one = getComputedStyle(document.documentElement).getPropertyValue('--viz-1').trim(); const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
                const sparks = [...document.querySelectorAll('.cost-card-sparkline svg')], strokes = sparks.map(s => s.querySelector('polyline').getAttribute('stroke'));
                const over = []; for (const s of sparks) { const card = s.closest('.cost-card'), sr = s.getBoundingClientRect(); for (const t of card.querySelectorAll('*')) { if (s.contains(t) || t.contains(s) || t.closest('.cost-card-sparkline')) continue; if (![...t.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue; const r = t.getBoundingClientRect(); if (r.width && r.height && hit(r, sr)) over.push((card.querySelector('.cost-card-label') || {}).textContent + ': ' + t.textContent.trim().slice(0, 20)); } }
                return { one, strokes, over, n: sparks.length, sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            assert.ok(d.one && d.strokes.length >= 5 && d.strokes.every(s => s === d.one), `${tag}: every tile sparkline is --viz-1 (${d.one}): ${JSON.stringify(d.strokes)}`);
            assert.deepEqual(d.over, [], `${tag}: no text runs over a sparkline`);
            await shot(`analytics-tiles-${w}-${theme}${fontPx ? '-200' : ''}`);
        }
        console.log('PASS Analytics tile sparklines are one colour and nothing runs over them: 1440 and 390, dark and light, 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
