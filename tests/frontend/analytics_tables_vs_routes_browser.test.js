// The Analytics By agent and Efficiency tables, cell by cell against the JSON of their routes (#9516, #9511 part 2): every figure is the route's number in the one Analytics format (K, M and B with no space, one decimal at
// most and no trailing zero; durations as 38 s, 2 min, 1 h 02 min; cost in cents, "<$0.01" under a cent, $0.00 for a zero, "—" for none), a count is whole, a share is a rounded percent, an empty cell is "—". The routes are stubbed
// with fixed JSON that has the edges (999 and 1,000, 999,949 and 999,960, a zero, a null, a low sample). 1280 px. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const AGENTS = [
    { session_id: 's1', agent_name: 'Backend Dev', board_name: 'team-x', folder: 'coral', working_dir: '/w/coral', requests: 1234, input_tokens: 1234567, output_tokens: 999, cache_read_tokens: 999400, cache_write_tokens: 0, cost_usd: 12.345, first_seen: '2026-10-20T10:00:00Z', last_seen: '2026-10-20T12:05:00Z', stopped_at: '2026-10-20T12:05:00Z' },
    { session_id: 's2', agent_name: 'Idle Agent', board_name: '', folder: '', working_dir: '', requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, first_seen: '2026-10-21T10:00:00Z', last_seen: '2026-10-21T10:00:38Z', stopped_at: '2026-10-21T10:00:38Z' },
    { session_id: 's3', agent_name: 'Tiny', board_name: 'team-x', folder: 'docs', working_dir: '/w/docs', requests: 3, input_tokens: 1000, output_tokens: 1049, cache_read_tokens: 999949, cache_write_tokens: 999950, cost_usd: 0.004, first_seen: '2026-10-22T10:00:00Z', last_seen: '2026-10-22T10:02:00Z', stopped_at: '2026-10-22T10:02:00Z' },
];
const TPC = { metric: 'tokens_per_commit', range: '24h', min_sample: 10, total: { n: 76 }, average: { value: 300000, usual: 310000 }, groups: [
    { key: 'haiku', label: 'claude-haiku-5-5', value: 141000, n: 51, tokens: 7191000, cost_usd_per_unit: 0.42 },
    { key: 'opus', label: 'claude-opus-5-5', value: 516700, n: 12, tokens: 6200400, cost_usd_per_unit: 12.3456 },
    { key: 'gpt', label: 'gpt-5', value: 999960, n: 10, tokens: 999, cost_usd_per_unit: 0.004 },
    { key: 'none', label: 'no-commits', value: null, n: 0, tokens: 1500 },
    { key: 'few', label: 'three-commits', value: 1049, n: 3, tokens: 3147, cost_usd_per_unit: 0, low_sample: true }] };
const TT = { metric: 'task_time', range: '24h', min_sample: 10, total: { n: 150 }, average: { value: 1080, usual: 1000 }, groups: [
    { key: 'low', label: 'Low', value: 38, n: 57, sent_back_share: 0.285, cost_usd_per_unit: 1.4 },
    { key: 'high', label: 'High', value: 125, n: 88, sent_back_share: 0, cost_usd_per_unit: 0 },
    { key: 'max', label: 'Max', value: 3725, n: 5, sent_back_share: 1, cost_usd_per_unit: 9.999 }] };
const STUB = `(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o) => { const url = String(u && u.url || u), p = new URL(url, location.origin);
        if (p.pathname === '/api/analytics/efficiency') return json(p.searchParams.get('metric') === 'task_time' ? ${JSON.stringify(TT)} : ${JSON.stringify(TPC)});
        if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 1, output_tokens: 1, cost_usd: 1 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: ${JSON.stringify(AGENTS)} });
        if (url.includes('/api/token-usage/timeseries')) return json({ buckets: [{ bucket: '2026-10-20T00:00:00Z', cost_usd: 1, cumulative_cost: 1 }, { bucket: '2026-10-21T00:00:00Z', cost_usd: 3, cumulative_cost: 4 }] });
        if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
        if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
        if (url.includes('/api/token-usage/')) return json({});
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const dump = {};
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`try { for (const k of Object.keys(localStorage)) if (k.includes('coral-eff-group')) localStorage.removeItem(k); } catch {} window.switchNavTab('tokens'); true`);
        await waitFor(`!!document.querySelector('#cost-group-bar .eff-seg-btn')`, 'the Analytics page', 10000);
        const table = sel => ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)} + ' table'); if (!t) return null; const vis = e => e.getClientRects().length > 0; const heads = [...t.querySelectorAll('thead th')].filter(vis).map(h => h.textContent.replace(/[\\u2195\\u2191\\u2193]/g, '').trim());
            const keys = [...t.querySelectorAll('thead th')].map((h, i) => [i, vis(h), h.textContent.replace(/[\\u2195\\u2191\\u2193]/g, '').trim()]).filter(x => x[1]);
            return { heads, rows: [...t.querySelectorAll('tbody tr')].filter(vis).map(r => keys.map(([i]) => (r.children[i] ? r.children[i].textContent.replace(/\\s+/g, ' ').trim() : ''))) }; })()`);
        // the burn rate is an estimate, said on hover only (UI/UX, #9511): 4 dollars over the 24 hours between the buckets
        await waitFor(`document.getElementById('cost-burn-rate').textContent.trim() === '$0.17/hr'`, 'the burn rate', 8000);
        assert.equal(await ev(`document.getElementById('cost-burn-rate').title`), 'Estimated from the buckets in this range', 'the burn rate says it is an estimate on hover');
        // By agent: Overview, Group by Agent
        await ev(`[...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].find(b => b.textContent === 'Agent').click(); true`);
        await waitFor(`!!document.querySelector('#cost-by-agent table tbody tr')`, 'the By agent rows', 8000);
        dump.agent = await table('#cost-by-agent'); await shot('tables-by-agent');
        // Tokens per commit by Model
        await ev(`document.querySelector('#cost-nav-list .row-btn[data-view="per-commit"]').click(); true`);
        await waitFor(`!!document.querySelector('#cost-spend-section .eff-seg-btn[data-group="model"]')`, 'the Group by switch', 8000);
        await ev(`document.querySelector('#cost-spend-section .eff-seg-btn[data-group="model"]').click(); true`); // the page starts on All (#10482): the by-model table is a choice
        await waitFor(`document.querySelectorAll('#cost-eff-per-commit tbody tr').length === 5`, 'the Tokens per commit rows', 10000);
        dump.tpc = await table('#cost-eff-per-commit'); await shot('tables-tokens-per-commit');
        // Task time by Thinking level
        await ev(`document.querySelector('#cost-nav-list .row-btn[data-view="task-time"]').click(); true`);
        await ev(`(() => { const sec = document.getElementById('cost-task-time-section'); const b = [...sec.querySelectorAll('.eff-seg-btn')].find(x => x.textContent === 'Thinking level'); if (b) b.click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#cost-eff-task-time tbody tr').length === 3`, 'the Task time rows', 10000);
        dump.tt = await table('#cost-eff-task-time'); await shot('tables-task-time');
        const noIcon = heads => heads.map(h => h.replace(/filter_list$/, ''));
        // By agent: the route's rows in cost order; every cell as the route's number reads in the one Analytics format
        assert.deepEqual(noIcon(dump.agent.heads), ['Agent', 'Cost', 'Team', 'Folder', 'Launched', 'Duration', 'Requests', 'Input', 'Output', 'Details'], 'By agent: the columns a desktop draws');
        const strip = rows => rows.map(r => r.map((c, i) => (i === 4 ? (/^[A-Z][a-z]{2} \d+, 2026 \d\d:\d\d:\d\d [AP]M$/.test(c) ? 'time' : c) : c)));
        assert.deepEqual(strip(dump.agent.rows), [
            ['Backend Dev', '$12.35', 'team-x', 'coral', 'time', '2 h 05 min', '1234', '1.2M', '999', 'Charts'],
            ['Tiny', '$0.0040', 'team-x', 'docs', 'time', '2 min', '3', '1K', '1K', 'Charts'],
            ['Idle Agent', '$0.00', '—', '—', 'time', '38 s', '0', '0', '0', 'Charts']], 'By agent: cost (cents; four places under a cent; $0.00), tokens (1,234,567 is 1.2M, 999 is 999, 1,000 and 1,049 are 1K), whole counts, durations, and an empty team or folder is a dash');
        // Tokens per commit by model
        assert.deepEqual(dump.tpc.heads, ['Model', 'Tokens per commit', 'vs average', 'Commits', 'Tokens', 'Cost per commit'], 'Tokens per commit: the columns');
        assert.deepEqual(dump.tpc.rows, [
            ['claude-haiku-5-5most efficient', '141K', '-53%', '51', '7.2M', '$0.42'],
            ['claude-opus-5-5', '516.7K', '+72%', '12', '6.2M', '$12.35'],
            ['gpt-5', '1M', '+233%', '10', '999', '<$0.01'],
            ['three-commitsfew', '1K', '-100%', '3', '3.1K', '$0.00'],
            ['no-commitsno data', '—', '—', '0', '1.5K', '—']], 'Tokens per commit: each figure is the route\'s in the one format (999,960 is 1M), the percent against the average of 300K, cents, "<$0.01", $0.00 for a zero and a dash for none');
        // Task time by thinking level
        assert.deepEqual(dump.tt.heads, ['Thinking level', 'Median time', 'vs median', 'Tasks', 'Sent back', 'Cost per task'], 'Task time: the columns');
        assert.deepEqual(dump.tt.rows, [
            ['Lowfastest', '38 s', '-96%', '57', '29%', '$1.40'],
            ['High', '2 min', '-88%', '88', '0%', '$0.00'],
            ['Maxfew', '1 h 02 min', '+245%', '5', '100%', '$10.00']], 'Task time: 38 s, 2 min, 1 h 02 min; a share of 0.285 is 29% (halves up, not the float 28%); cost to the cent');
        console.log('analytics_tables_vs_routes: ok');
        process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
})();
