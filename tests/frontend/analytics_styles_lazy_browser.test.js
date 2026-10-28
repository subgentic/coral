// The Analytics page's stylesheet loads with the page (#10706): the start has no link to css/cost_dashboard.css, opening Analytics adds it before the page shows, and the page looks as it did when the file was in the start's
// bundle: a shot of every view at 1280 and 390 px, light and dark, is saved when CORAL_SCREENSHOT_DIR is set (the same suite on the tree before the move gives the shots to compare). Stubbed answers, isolated dev server over CDP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const Z = { cache_read_tokens: 10, cache_write_tokens: 5 };
const MODEL = [{ model: 'claude-opus-5-5', agent_type: 'claude', num_sessions: 3, input_tokens: 2000, output_tokens: 300, ...Z, cost_usd: 2.5 }, { model: 'claude-sonnet-5-5', agent_type: 'claude', num_sessions: 1, input_tokens: 900, output_tokens: 100, ...Z, cost_usd: 0.4 }];
const PROVIDER = [{ agent_type: 'claude', num_sessions: 4, input_tokens: 2900, output_tokens: 400, ...Z, cost_usd: 2.9 }];
const THINKING = [{ agent_type: 'claude', model: 'claude-opus-5-5', thinking: 'high', input_tokens: 2000, output_tokens: 300, ...Z, thinking_tokens: 4000, cost_usd: 2.0, num_calls: 9 }];
const AGENT = [{ session_id: 'a1', agent_name: 'Frontend Developer', board_name: 'coral-go-team', folder: 'coral', requests: 12, input_tokens: 5000, output_tokens: 700, ...Z, cost_usd: 3.2, first_seen: '2026-10-19T00:00:00Z', last_seen: '2026-10-25T00:00:00Z' }];
const TEAMS = [{ board_name: 'coral-go-team', num_agents: 6, input_tokens: 9000, output_tokens: 1000, ...Z, cost_usd: 8.5 }];
const CALLS = [{ operation: 'Bash', call_type: 'tool', agent_name: 'Frontend Dev', board_name: 'coral-go-team', calls: 30, errors: 2, avg_duration_ms: 120 }];
const VIEWS = ['overview', 'provider', 'model', 'thinking', 'team', 'agent', 'per-commit', 'task-time', 'calls'];

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); await sleep(500); /* sleep-ok: a shot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const stub = () => ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10000, output_tokens: 2000, cost_usd: 4, num_requests: 52 }, by_model: ${JSON.stringify(MODEL)}, by_thinking: ${JSON.stringify(THINKING)}, by_agent_type: ${JSON.stringify(PROVIDER)}, by_agent: ${JSON.stringify(AGENT)} });
            if (url.includes('/api/call-metrics/summary')) return json({ rows: ${JSON.stringify(CALLS)}, hours: 336 });
            if (url.includes('/api/token-usage/by-team')) return json({ teams: ${JSON.stringify(TEAMS)} });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/timeseries')) return json({ buckets: Array.from({ length: 24 }, (_, i) => ({ bucket: '2026-10-27T' + String(i).padStart(2, '0') + ':00:00Z', cost_usd: 1 + i % 3, cumulative_cost: i + 1 })) });
            return R(u, o); }; return true; })()`);
    const linked = () => ev(`[...document.querySelectorAll('link[rel=stylesheet]')].some(l => /css\\/cost_dashboard\\.css/.test(l.href))`);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1280, 900, false, 'dark'], [1280, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light']]) {
            await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [] });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
            if (await linked()) problems.push(`${w}/${theme}: the start already links cost_dashboard.css`);
            await stub(); await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`!!document.getElementById('cost-total-cost') && document.getElementById('cost-total-cost').textContent === '$4.00'`, 'the summary', 15000);
            if (!await linked()) problems.push(`${w}/${theme}: opening Analytics did not link cost_dashboard.css`);
            const styled = await ev(`(() => { const c = document.querySelector('#cost-summary-cards .cost-card'); return !!c && getComputedStyle(c).borderTopWidth !== '0px' && getComputedStyle(c).borderRadius !== '0px'; })()`);
            if (!styled) problems.push(`${w}/${theme}: the cards are not styled when the page shows`);
            for (const key of VIEWS) {
                await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView(${JSON.stringify(key)})).then(() => true)`);
                await sleep(700); /* sleep-ok: the page draws its tables and chart after the read */
                await shot(`analytics-${w}-${theme}-${key}`);
            }
        }
        assert.deepEqual(problems, [], problems.join(' | '));
        console.log('PASS analytics_styles_lazy');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
