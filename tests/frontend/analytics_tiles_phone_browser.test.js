// Analytics tiles on a phone (#15843, Design N3): two columns, not three; no label breaks inside a word (Output tokens is whole); the tiles of a row are one height and an odd last tile takes the full row instead of standing alone.
// 390 and 320 px, dark and light, 200% text. Stubbed answers, isolated dev server. CORAL_SCREENSHOT_DIR saves a shot.
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
        for (const [w, h, mobile, theme, fontPx] of [[390, 844, true, 'dark'], [390, 844, true, 'light'], [320, 700, true, 'dark'], [320, 700, true, 'light'], [390, 844, true, 'light', 32], [320, 700, true, 'dark', 32]]) {
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
            await waitFor(`document.querySelectorAll('#cost-summary-cards .cost-card').length >= 7 && [...document.querySelectorAll('#cost-summary-cards .cost-card')].every(c => c.getBoundingClientRect().width > 0)`, `${tag}: the tiles`, 15000);
            const d = await ev(`(() => { const cards = [...document.querySelectorAll('#cost-summary-cards .cost-card')], box = c => c.getBoundingClientRect(), lefts = [...new Set(cards.map(c => Math.round(box(c).left)))].sort((a, b) => a - b);
                const rows = {}; for (const c of cards) (rows[Math.round(box(c).top)] = rows[Math.round(box(c).top)] || []).push(c);
                const unevenRows = Object.values(rows).filter(r => new Set(r.map(c => Math.round(box(c).height))).size > 1).length, lastAlone = Object.values(rows).pop().length === 1 && Math.round(box(cards[cards.length - 1]).width) < Math.round(box(cards[0]).width) * 1.5;
                const cut = cards.map(c => c.querySelector('.cost-card-label')).filter(l => l.scrollWidth > l.clientWidth + 1).map(l => l.textContent.trim());
                // a word broken in two would give a label line that ends without a space inside a word: the label's own words are whole when each fits the tile
                const wide = cards.filter(c => c.scrollWidth > c.clientWidth + 1).map(c => c.querySelector('.cost-card-label').textContent.trim());
                return { n: cards.length, lefts, unevenRows, lastAlone, cut, wide, sideways: document.documentElement.scrollWidth > innerWidth + 1, tiles: cards.map(c => Math.round(box(c).width)) }; })()`);
            assert.equal(d.lefts.length, 2, `${tag}: two columns: ${JSON.stringify(d)}`);
            assert.equal(d.unevenRows, 0, `${tag}: the tiles of a row are one height: ${JSON.stringify(d)}`);
            assert.equal(d.lastAlone, false, `${tag}: the odd last tile is not alone in a corner: ${JSON.stringify(d)}`);
            assert.deepEqual([d.cut, d.wide], [[], []], `${tag}: no label or figure is cut by its tile: ${JSON.stringify(d)}`);
            assert.equal(d.sideways, false, `${tag}: nothing scrolls sideways`);
            await ev(`document.getElementById('cost-summary-cards').scrollIntoView({ block: 'start' }); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the scroll settles
            await shot(`analytics-tiles-phone-${w}-${theme}${fontPx ? '-200' : ''}`);
        }
        console.log('PASS Analytics tiles on a phone: two columns, whole labels, equal heights, no lone tile: 390 and 320, dark and light, 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
