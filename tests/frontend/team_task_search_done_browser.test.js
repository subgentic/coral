// Team Tasks search finds Done tasks (#16702): a search that matches only a Done task must show it, not "No tasks match this search",
// and the chip counts must reflect the match. The bug: the "open first" sort sends two phased queries; the done phase's rows never
// reach the displayed list. Failing-first browser test.
//
// Expects CORAL_TEST_URL + CDP_PORT from the runner. Exit 0 / 1.
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-done-search-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    // Stub: one open task and one done task. The query route filters by q and status.
    const stub = () => ev(`(() => { const R = window.fetch.bind(window);
        const T = (id, title, status, extra = {}) => ({ id, title, status, priority: 'high', created_by: 'Orchestrator', assigned_to: 'Backend Dev', created_at: '2026-10-25T06:00:00Z', updated_at: '2026-10-25T07:00:00Z', ...extra });
        const OPEN = [T(1, 'Fix the login bug', 'in_progress')];
        const DONE = [T(2, 'Write README.md for csvstats', 'completed', { completed_at: '2026-10-24T12:00:00Z' })];
        const ALL = [...OPEN, ...DONE];
        const j = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/tasks') {
                const q = (url.searchParams.get('q') || '').toLowerCase();
                const statuses = url.searchParams.getAll('status');
                const limit = parseInt(url.searchParams.get('limit') || '50', 10);
                let pool = ALL;
                if (statuses.length) pool = ALL.filter(t => statuses.includes(t.status));
                const hit = q ? pool.filter(t => t.title.toLowerCase().includes(q)) : pool;
                return j({ tasks: hit.slice(0, limit), next_cursor: '', total: hit.length, truncated: false });
            }
            if (/^\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname)) {
                if (url.searchParams.get('counts') === '1') return j({ tasks: [], total_open: 1, total_completed: 1 });
                return j({ tasks: ALL, next_cursor: '', total_open: 1, total_completed: 1 });
            }
            return R(u, o); }; return true; })()`);
    const typeSearch = v => ev(`(() => { const i = document.querySelector('#team-panel-tasks input[aria-label="Search tasks"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await stub(); await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Tasks'); await settle(600);

        await S.run('a search that matches only a Done task does not say "No tasks match this search"', async () => {
            await typeSearch('README'); await settle(800);
            const text = await ev(`document.getElementById('team-panel-tasks').textContent`);
            assert.ok(!text.includes('No tasks match this search'), '"No tasks match this search" must not appear when a done task matches');
        });

        await S.run('switching to All shows the done task', async () => {
            await ev(`document.querySelector('#team-panel-tasks .goals-chip[data-filter="all"]').click(); true`); await settle(400);
            const r = await ev(`window.__tp.rows() || []`);
            assert.ok(r.length > 0, `at least one row after All, got ${r.length}`);
            assert.ok(r.some(t => /README/i.test(t)), `the done task is shown: ${JSON.stringify(r)}`);
        });

        await S.run('chip counts reflect the search', async () => {
            const chips = await ev(`window.__tp.chips(/Show tasks/i) || []`);
            const all = chips.find(c => /^All\\b/i.test(c.name));
            assert.ok(all, `an All chip: ${JSON.stringify(chips)}`);
            assert.ok(!/\\b0$/.test(all.name.trim()), `All is not 0: ${all.name}`);
        });

        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
