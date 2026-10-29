// Analytics > Cost by team names a team by its name, not its board id (#10936, the phone pass: a row said "b-6xccqbikbn" for the team "phone-pass"). The by-team answer carries each row's board_label and the page uses it
// as the team's name, with the id as the fallback for a board that has no label. Desktop and a 390 px phone. Drives Chrome over CDP through agent_view_harness.js with the census data world, its by-team answer replaced.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');

const TEAMS = { teams: [
    { board_name: 'b-6xccqbikbn', board_label: 'phone-pass', num_agents: 3, input_tokens: 9000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 10000, cost_usd: 4.5 },
    { board_name: 'b-nolabel0001', board_label: 'b-nolabel0001', num_agents: 1, input_tokens: 900, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 1000, cost_usd: 0.5 },
] };
const OVERRIDE = `(() => { const prev = window.fetch; window.fetch = (u, o) => /\\/api\\/token-usage\\/by-team(\\?|$)/.test(String(u && u.url || u)) ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(TEAMS))}, { status: 200, headers: { 'content-type': 'application/json' } })) : prev(u, o); })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD }); await Page.addScriptToEvaluateOnNewDocument({ source: OVERRIDE });
        for (const [w, h, mobile, tag] of [[1280, 800, false, 'desktop'], [390, 844, true, 'phone']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`document.querySelectorAll('#cost-by-team tbody tr').length >= 2`, `${tag}: the team rows`, 15000);
            const rows = await ev(`[...document.querySelectorAll('#cost-by-team tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.ok(rows.some(t => t.includes('phone-pass')), `${tag}: the team's row says its name: ${JSON.stringify(rows)}`);
            assert.ok(!rows.some(t => t.includes('b-6xccqbikbn')), `${tag}: and not its board id: ${JSON.stringify(rows)}`);
            assert.ok(rows.some(t => t.includes('b-nolabel0001')), `${tag}: a board with no label shows its id: ${JSON.stringify(rows)}`);
            console.log(`   ✓ ${tag}`);
        }
        console.log('PASS Analytics > Cost by team names a team by its label, with the id as the fallback');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
