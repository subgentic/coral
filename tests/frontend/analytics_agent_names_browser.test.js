// By agent names its rows (#10272, Desktop pass 22): an agent with no name on record is called by its folder, not "Agent" (and its chart line is not "(unknown)"); a running agent that sent nothing
// in the range is a row at $0.00; a running agent's context used is a column beside its cost. 1280 px, stubbed /api/token-usage answers and a live list set in the page. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const AGENTS = [
    { session_id: 'u1', agent_name: 'a2', folder: 'a2', board_name: 'team-x', requests: 12, input_tokens: 4000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 1.5, first_seen: '2026-10-28T08:00:00Z', last_seen: '2026-10-28T09:00:00Z', is_live: true },
    { session_id: 'u2', agent_name: 'Reviewer', folder: 'coral', board_name: 'team-x', requests: 3, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.2, first_seen: '2026-10-28T08:00:00Z', last_seen: '2026-10-28T09:00:00Z', is_live: false },
];
const LIVE = [
    { name: 'a2', session_id: 'u1', agent_type: 'claude', display_name: '', working_directory: '/w/a2', context_pct: 42, created_at: '2026-10-28T08:00:00Z' },
    { name: 'quiet', session_id: 'u9', agent_type: 'codex', display_name: 'Quiet one', working_directory: '/w/quiet', context_pct: null, created_at: '2026-10-28T08:30:00Z' },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const stub = () => ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 4900, output_tokens: 790, cost_usd: 1.7, num_requests: 15 }, by_agent_type: [], by_model: [], by_thinking: [], by_agent: ${JSON.stringify(AGENTS)} });
            if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/timeseries')) return json({ buckets: [], interval: '1h' });
            if (url.includes('/api/token-usage/')) return json({});
            return R(u, o); }; return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await stub();
        await ev(`import(${MOD} + 'state.js').then(m => { m.state.liveSessions = ${JSON.stringify(LIVE)}; return true; })`);
        await ev(`window.switchNavTab('tokens'); true`);
        await ev(`import(${MOD} + 'analytics_views.js').then(m => { m.selectView('agent'); return true; })`);
        await waitFor(`document.querySelectorAll('#cost-by-agent tbody tr').length === 3`, 'the two agents with usage and the quiet one', 15000);
        const rows = await ev(`(() => { const heads = [...document.querySelectorAll('#cost-by-agent thead th')].map(h => h.textContent.replace(/[\\u2195\\u2191\\u2193]/g, '').trim());
            const col = n => heads.findIndex(h => h.startsWith(n));
            return { heads, rows: [...document.querySelectorAll('#cost-by-agent tbody tr')].map(r => { const c = [...r.children].map(x => x.textContent.trim()); return { name: c[0], cost: c[col('Cost')], ctx: c[col('Context')], req: c[col('Requests')] }; }) }; })()`);
        const by = n => rows.rows.find(r => r.name.startsWith(n));
        assert.ok(by('a2'), 'an agent with no name on record is called by its folder: ' + JSON.stringify(rows));
        assert.ok(!rows.rows.some(r => /^Agent\b/.test(r.name)), 'no row is called "Agent": ' + JSON.stringify(rows.rows));
        assert.ok(rows.heads.some(h => /^Context/.test(h)), 'a Context column: ' + rows.heads.join('|'));
        assert.equal(by('a2').ctx, '42%', 'a running agent shows its context used');
        assert.equal(by('Reviewer').ctx, '–', 'an ended agent has none');
        assert.ok(by('Quiet one'), 'the running agent with no requests is listed: ' + JSON.stringify(rows.rows));
        assert.deepEqual([by('Quiet one').cost, by('Quiet one').req], ['$0.00', '0'], 'at $0.00 with no requests');
        console.log('PASS analytics By agent: names, the quiet running agent at $0.00, context used');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
