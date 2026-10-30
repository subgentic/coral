// The team's token-usage dialog is data_table (#7904): By agent's column order (Agent, Cost, then the tokens), the dearest member first, K/M/B figures, a click on a head sorts, and at 390 px it folds
// (the figure the rows are sorted by is the one stronger line). From a stubbed /api/token-usage?board_name=.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

// the unified usage API's real shape (#7987: the dialog read a by_agent this route never sends, so on a real server it said "No token usage recorded"): one record per session, so one agent in two sessions is one row
const USAGE = { totals: { total_tokens: 99, cost_usd: 12.5, execution_time_sec: 0 }, records: [
    { session_id: 's1', agent_name: 'Frontend Dev', input_tokens: 15000000000, output_tokens: 2000000, cache_read_tokens: 1000, cache_write_tokens: 900000, cost_usd: 6, num_turns: 40 },
    { session_id: 's1b', agent_name: 'Frontend Dev', input_tokens: 491800000, output_tokens: 500000, cache_read_tokens: 234, cache_write_tokens: 99950, cost_usd: 3.5, num_turns: 9 },
    { session_id: 's2', agent_name: 'Backend Dev', input_tokens: 5000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 3, num_turns: 4 },
    { session_id: 's3', agent_name: 'QA Engineer', input_tokens: 900, output_tokens: 90, cache_read_tokens: 10, cache_write_tokens: 0, cost_usd: 0.12, num_turns: 2 }] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => { const url = String(u && u.url || u); if (url.includes('/api/token-usage?board_name=')) return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(USAGE)}), { headers: { 'content-type': 'application/json' } })); return R(u, o); }; return true; })()`);
        const open = async () => { await ev(`window.showTeamTokenUsage('coral-go-team'); true`); await waitFor(`document.querySelectorAll('#task-detail-content .dt-table tbody tr').length === 3`, 'the members table'); };
        const names = () => ev(`[...document.querySelectorAll('#task-detail-content .dt-table tbody tr')].map(r => r.children[0].textContent.trim())`);

        console.log('1. Columns in By agent\'s order, the dearest member first, K/M/B figures');
        await open();
        const heads = await ev(`[...document.querySelectorAll('#task-detail-content .dt-table thead th')].map(th => th.dataset.key)`);
        assert.deepEqual(heads, ['name', 'total_cost_usd', 'total_input_tokens', 'total_output_tokens', 'total_cache_read_tokens', 'total_cache_write_tokens']);
        assert.deepEqual(await names(), ['Frontend Dev', 'Backend Dev', 'QA Engineer']);
        const first = await ev(`[...document.querySelector('#task-detail-content .dt-table tbody tr').children].map(c => c.textContent.trim())`);
        assert.deepEqual(first, ['Frontend Dev', '$9.50', '15.5B', '2.5M', '1.2K', '1.0M'], 'a thousand million reads B, and a figure that rounds up moves into the next unit');
        assert.equal(await ev(`document.querySelectorAll('#task-detail-content table.cost-table').length`), 0, 'the old table is gone');
        await shot('team-token-usage-1280'); console.log('   ✓');

        console.log('2. A head sorts, and again reverses');
        await ev(`document.querySelector('#task-detail-content .dt-table th[data-key="name"] .dt-sort').click(); true`);
        assert.deepEqual(await names(), ['Backend Dev', 'Frontend Dev', 'QA Engineer']);
        await ev(`document.querySelector('#task-detail-content .dt-table th[data-key="name"] .dt-sort').click(); true`);
        assert.deepEqual(await names(), ['QA Engineer', 'Frontend Dev', 'Backend Dev']);
        console.log('   ✓');

        console.log('3. At 390 px it folds: no sideways scroll, the sort key is the one stronger line');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await open();
        await waitFor(`document.querySelector('#task-detail-content .dt-box').classList.contains('dt-folded')`, 'the fold');
        const fold = await ev(`(() => { const box = document.querySelector('#task-detail-content .dt-box'); return { sideways: box.scrollWidth > box.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth + 1, head: getComputedStyle(box.querySelector('thead')).display, strong: [...box.querySelectorAll('tbody tr:first-child td.dt-fold-key')].map(c => c.dataset.label), select: !!box.querySelector('.dt-sortbar-select') }; })()`);
        assert.deepEqual([fold.sideways, fold.page, fold.head, fold.select], [false, false, 'none', true], JSON.stringify(fold));
        assert.equal(fold.strong.length, 1, JSON.stringify(fold));
        await shot('team-token-usage-390'); console.log('   ✓');
        console.log('PASS team token usage: data_table, By agent\'s order, K/M/B, sort, fold');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
