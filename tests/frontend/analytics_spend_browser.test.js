// The Analytics tab's "Tokens per commit" section (#7526, UI/UX's pace r2): for one team, tokens per landed commit over the last 24 hours against the 7 days before, the usual line, a bar a day, who spends, and how it is counted. Counts come from
// GET /api/board/<team>/spend?range=24h|7d (stubbed here: the page divides); tokens are input plus output with the cache reads beside them; an agent with no token source is "Not measured" in one cell, never zero; the Orchestrator's commits read "team";
// an author that matches no agent is "Unattributed"; no commit is said, not divided by zero. 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const TEAM = 'coral-go-team';
const FIX = { board: TEAM, range_hours: 24, generated_at: '2026-10-25T10:00:00Z',
    tokens: { window: { input: 2000000, output: 1100000, cache_read: 61000000, cache_write: null }, usual: { input: 6000000, output: 3000000, cache_read: 90000000, cache_write: null } },
    commits: { window: 6, usual: 25, unattributed: 1 }, tool_calls: { window: 420, usual: 1500, measured_agents: 3, of_agents: 4 },
    per_day: [0, 1, 2, 3, 4, 5, 6].map(i => ({ day: `2026-10-${19 + i}`, tokens: i === 6 ? 3100000 : 1200000 + i * 20000, commits: i === 6 ? 6 : 3 })),
    agents: [{ name: 'Frontend Dev', role: 'Developer', tokens: 800000, share: 0.26, commits: 2, cache_reads: 14000000, tool_calls: 120, measured: true },
        { name: 'Orchestrator', role: 'Orchestrator', tokens: 600000, share: 0.19, commits: null, cache_reads: 12000000, tool_calls: 90, measured: true },
        { name: 'Gemini Dev', role: 'Developer', tokens: null, share: null, commits: 2, cache_reads: null, tool_calls: null, measured: false },
        { name: 'Unattributed', role: '', tokens: null, share: null, commits: 1, cache_reads: null, tool_calls: null, measured: false }], measured_agents: 3, of_agents: 4 };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String(e.message).slice(0, 300)); } };
    const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { window.__spendReq = []; window.__spend = ${JSON.stringify(FIX)}; window.__spendStatus = 200; const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (/\\/api\\/board\\/[^/]+\\/spend$/.test(url.pathname)) { window.__spendReq.push(url.search); return Promise.resolve(new Response(JSON.stringify(window.__spend), { status: window.__spendStatus, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); };
            window._coralSetLiveSessions([{ session_id: 'a-1', name: 'a-1', agent_type: 'claude', board_project: '${TEAM}', display_name: 'Frontend Dev', working_directory: '/tmp/x' }]); return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-spend .spend-card').length >= 5`, 'the section', 10000);
        await run('the headline and the numbers: tokens per commit, usual, commits, cache reads (not in the total), tool calls', async () => {
            assert.equal(await text('#cost-spend .spend-headline'), '517 K tokens per commit, usual 360 K, 44% above.');
            const cards = await ev(`[...document.querySelectorAll('#cost-spend .spend-card')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.ok(/^517 K\s*tokens per landed commit, 24 h/.test(cards[0]), cards[0]); assert.ok(/^360 K\s*usual/.test(cards[1]), cards[1]); assert.ok(/^6\s*commits landed on main\s*1 unattributed/.test(cards[2]), cards[2]);
            assert.ok(/^61 M\s*cache reads, not in the total/.test(cards[3]), cards[3]); assert.ok(/^70\s*tool calls per landed commit.*3 of 4 agents measured/.test(cards[4]), cards[4]);
            assert.match(await text('#cost-spend .spend-sub'), /Team coral-go-team · last 24 h against the 7 days before/);
        });
        await run('one bar a day, today amber when 30% above usual, the usual line', async () => {
            const b = await ev(`(() => ({ bars: document.querySelectorAll('#cost-spend .spend-bar').length, high: [...document.querySelectorAll('#cost-spend .spend-bar')].map(x => x.classList.contains('spend-bar-high')), usual: !!document.querySelector('#cost-spend .spend-usual'), label: document.querySelector('#cost-spend .spend-bars').getAttribute('aria-label') }))()`);
            assert.equal(b.bars, 7); assert.deepEqual(b.high, [false, false, false, false, false, false, true]); assert.equal(b.usual, true); assert.match(b.label, /usual 360 K/);
        });
        await run('who spends: a merged Not measured cell, team for the Orchestrator, an Unattributed row', async () => {
            const t = await ev(`[...document.querySelectorAll('#cost-spend .spend-table tbody tr')].map(r => [...r.children].map(c => c.textContent.trim() + (c.colSpan > 1 ? '[x' + c.colSpan + ']' : '')))`);
            assert.deepEqual(t[0], ['Frontend Dev', '800 K', '26%', '2', '14 M', '120']); assert.deepEqual(t[1], ['Orchestrator', '600 K', '19%', 'team', '12 M', '90']);
            assert.deepEqual(t[2], ['Gemini Dev', 'Not measured[x5]']); assert.deepEqual(t[3], ['Unattributed', '—', '—', '1', '—', '—']);
            assert.ok(await ev(`!!document.querySelector('#cost-spend .spend-how')`), 'How it is counted');
        });
        await run('no commit landed is said, not divided by zero', async () => {
            await ev(`window.__spend = { ...window.__spend, commits: { window: 0, usual: 25, unattributed: 0 } }; true`); await ev(`window._refreshCostDashboard ? window._refreshCostDashboard() : 0; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`/No commit landed/.test((document.querySelector('#cost-spend .spend-headline') || {}).textContent || '')`, 'the no-commit headline', 6000);
            assert.equal(await text('#cost-spend .spend-headline'), 'No commit landed in 24 h. 3.1 M tokens were spent.');
        });
        await run('the 7 day range asks range=7d; a 404 says there is no data', async () => {
            await ev(`document.getElementById('cost-time-range').value = 'week'; document.getElementById('cost-time-range').dispatchEvent(new Event('change', { bubbles: true })); true`);
            await waitFor(`window.__spendReq.some(s => /range=7d/.test(s))`, 'a request with range=7d', 6000);
            await ev(`window.__spendStatus = 404; true`); await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`/No spend data for this team yet/.test(document.getElementById('cost-spend').textContent)`, 'the no-data line', 6000);
        });
        await run('at 390 px nothing is wider than the screen', async () => {
            await ev(`window.__spendStatus = 200; window.__spend = ${JSON.stringify(FIX)}; document.getElementById('cost-time-range').value = 'day'; true`);
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`document.querySelectorAll('#cost-spend .spend-card').length >= 5`, 'the section again', 6000);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true);
        });
    } finally { await client.close(); }
    const bad = results.filter(r => r[1]); console.log(`${results.length - bad.length}/${results.length} scenarios pass`); if (bad.length) { console.error('FAIL: ' + bad.map(r => r[0]).join('; ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
