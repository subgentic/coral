// Analytics at 390 px, every page (#10649, Desktop pass): Overview, Tokens per commit, Task time and Tool and API calls each read without sideways scroll (the page and every element that is not a scroll box of its own end inside the
// screen), the cards and charts fit, the tables fold to one line a row, and the question each page answers shows under its title. Touch emulation, stubbed answers, isolated dev server over CDP; CORAL_SCREENSHOT_DIR keeps a shot of each page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const Z = { cache_read_tokens: 10, cache_write_tokens: 5 };
const MODEL = [{ model: 'claude-opus-5-5', agent_type: 'claude', num_sessions: 3, input_tokens: 2000, output_tokens: 300, ...Z, cost_usd: 2.5 }, { model: 'claude-sonnet-5-5', agent_type: 'claude', num_sessions: 1, input_tokens: 900, output_tokens: 100, ...Z, cost_usd: 0.4 }];
const PROVIDER = [{ agent_type: 'claude', num_sessions: 4, input_tokens: 2900, output_tokens: 400, ...Z, cost_usd: 2.9 }, { agent_type: 'agy', num_sessions: 1, input_tokens: 100, output_tokens: 10, ...Z, cost_usd: 0.25 }];
const THINKING = [{ agent_type: 'claude', model: 'claude-opus-5-5', thinking: 'high', input_tokens: 2000, output_tokens: 300, ...Z, thinking_tokens: 4000, cost_usd: 2.0, num_calls: 9 }];
const AGENT = [{ session_id: 'a1', agent_name: 'Frontend Developer With A Long Name', board_name: 'coral-go-team', folder: 'coral', requests: 12, input_tokens: 5000, output_tokens: 700, ...Z, cost_usd: 3.2, first_seen: '2026-10-19T00:00:00Z', last_seen: '2026-10-25T00:00:00Z' }];
const TEAMS = [{ board_name: 'coral-go-team', num_agents: 6, input_tokens: 9000, output_tokens: 1000, ...Z, cost_usd: 8.5 }];
const CALLS = [{ operation: '/api/board/{project}/messages', call_type: 'api', agent_name: '', board_name: '', calls: 49, errors: 0, avg_duration_ms: 3 }, { operation: 'Bash', call_type: 'tool', agent_name: 'Frontend Dev', board_name: 'coral-go-team', calls: 30, errors: 2, avg_duration_ms: 120 }];
const VIEWS = [['overview', 'What am I spending?'], ['per-commit', 'What did each commit cost?'], ['task-time', 'How long do tasks take?'], ['calls', 'Which calls does the work make?']];

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); await sleep(350); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const stub = () => ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10000, output_tokens: 2000, cost_usd: 4, num_requests: 52 }, by_model: ${JSON.stringify(MODEL)}, by_thinking: ${JSON.stringify(THINKING)}, by_agent_type: ${JSON.stringify(PROVIDER)}, by_agent: ${JSON.stringify(AGENT)} });
            if (url.includes('/api/call-metrics/summary')) return json({ rows: ${JSON.stringify(CALLS)}, hours: 336 });
            if (url.includes('/api/token-usage/by-team')) return json({ teams: ${JSON.stringify(TEAMS)} });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/timeseries')) return json({ buckets: Array.from({ length: 24 }, (_, i) => ({ bucket: new Date(Date.now() - (24 - i) * 3600000).toISOString(), cost_usd: 1 + i % 3, cumulative_cost: i + 1 })) });
            return R(u, o); }; return true; })()`);
    // what runs past the screen: any visible element whose right edge is beyond the viewport and that no scroll box of its own holds
    const spill = () => ev(`(() => { const W = window.innerWidth, out = [];
        const held = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden') && p.clientWidth < p.scrollWidth + 1 && p.getBoundingClientRect().right <= W + 1) return true; } return false; };
        for (const el of document.querySelectorAll('#cost-dashboard-view *')) { if (!el.getClientRects().length) continue; const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > W + 1 && !held(el)) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' right=' + Math.round(r.right)); }
        return { page: document.documentElement.scrollWidth - W, view: document.getElementById('cost-dashboard-view').scrollWidth - document.getElementById('cost-dashboard-view').clientWidth, out: out.slice(0, 8) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await stub(); await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`!!document.getElementById('cost-dashboard-view') && document.getElementById('cost-total-cost') && document.getElementById('cost-total-cost').textContent !== '$0.00'`, 'the summary', 15000);
        const problems = [], picks = [];
        for (const [key, question] of VIEWS) {
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView(${JSON.stringify(key)})).then(() => true)`);
            await sleep(900); /* sleep-ok: the page draws its tables and chart after the read */
            const s = await spill();
            if (s.page > 0 || s.view > 0 || s.out.length) problems.push(`${key}: sideways overflow ${JSON.stringify(s)}`);
            const q = await ev(`(() => { const e = document.getElementById('cost-view-question'); return e && e.getClientRects().length ? e.textContent.trim() : null; })()`);
            if (q !== question) problems.push(`${key}: the question line is ${JSON.stringify(q)}, not ${JSON.stringify(question)}`);
            const wide = await ev(`[...document.querySelectorAll('#cost-dashboard-view table')].filter(t => t.getClientRects().length && t.getBoundingClientRect().width > window.innerWidth + 1).length`);
            if (wide) problems.push(`${key}: ${wide} table(s) wider than the screen (they fold to rows)`);
            // the wrapped range line does not start with the separator dot, and the Group by select is one control everywhere
            const sep = await ev(`(() => { const s = document.querySelector('#cost-compare-text .cost-compare-sep'); return s ? getComputedStyle(s).display : (document.getElementById('cost-compare-text').textContent.trim() ? 'no-sep-element' : 'none-needed'); })()`);
            if (sep === 'no-sep-element' || sep === 'inline') problems.push(`${key}: the comparison starts with a dot on a phone (${sep})`);
            const pick = await ev(`(() => { const p = [...document.querySelectorAll('.eff-pick')].find(e => e.getClientRects().length); return p ? { r: getComputedStyle(p).borderTopLeftRadius } : null; })()`);
            if (pick) { picks.push([key, pick]); }
            await shot(`analytics-390-${key}`);
        }
        if (picks.length > 1 && new Set(picks.map(p => p[1].r)).size > 1) problems.push('the Group by select differs between pages: ' + JSON.stringify(picks));
        assert.deepEqual(problems, [], 'Analytics at 390: ' + problems.join(' | '));
        console.log('PASS analytics_phone_pages');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
