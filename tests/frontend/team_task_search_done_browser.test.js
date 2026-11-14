// Team Tasks search finds Done tasks (#16702, #16743): a search that matches only a Done task must show it immediately (the pill
// auto-switches to All), not "No tasks match this search", and the chip counts must reflect the match. Clearing the search restores
// the previous pill. A filter-only empty state (#16690) says "No tasks match these filters" with Clear filters.
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
    // Stub: one open task and one done task. The query route filters by q and status; the agent filter filters by assigned_to.
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
                const agent = url.searchParams.get('assigned_to') || '';
                const prio = url.searchParams.get('priority') || '';
                let pool = ALL;
                if (statuses.length) pool = pool.filter(t => statuses.includes(t.status));
                if (agent) pool = pool.filter(t => t.assigned_to === agent);
                if (prio) pool = pool.filter(t => t.priority === prio);
                const hit = q ? pool.filter(t => t.title.toLowerCase().includes(q)) : pool;
                return j({ tasks: hit.slice(0, limit), next_cursor: '', total: hit.length, truncated: false });
            }
            if (/^\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname)) {
                if (url.searchParams.get('counts') === '1') return j({ tasks: [], total_open: 1, total_completed: 1 });
                return j({ tasks: ALL, next_cursor: '', total_open: 1, total_completed: 1 });
            }
            return R(u, o); }; return true; })()`);
    const typeSearch = v => ev(`(() => { const i = document.querySelector('#team-panel-tasks input[aria-label="Search tasks"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    const pill = () => ev(`(() => { const c = document.querySelector('#team-panel-tasks .goals-chip[aria-pressed="true"]'); return c ? c.dataset.filter : null; })()`);

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await stub(); await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Tasks'); await settle(600);

        await S.run('a search that matches only a Done task shows it immediately', async () => {
            assert.equal(await pill(), 'open', 'Open is the default pill');
            await typeSearch('README'); await settle(800);
            assert.equal(await pill(), 'all', 'the pill switches to All during a search');
            const r = await ev(`window.__tp.rows() || []`);
            assert.ok(r.length > 0, `at least one row, got ${r.length}`);
            assert.ok(r.some(t => /README/i.test(t)), `the Done task is listed: ${JSON.stringify(r)}`);
            const text = await ev(`document.getElementById('team-panel-tasks').textContent`);
            assert.ok(!text.includes('No tasks match this search'), '"No tasks match this search" must not appear');
            assert.ok(!text.includes('No tasks match this filter'), '"No tasks match this filter" must not appear');
        });

        await S.run('chip counts reflect the search', async () => {
            const chips = await ev(`window.__tp.chips(/Show tasks/i) || []`);
            const all = chips.find(c => /^All\b/i.test(c.name));
            assert.ok(all, `an All chip: ${JSON.stringify(chips)}`);
            assert.ok(!/\b0$/.test(all.name.trim()), `All is not 0: ${all.name}`);
        });

        await S.run('clearing the search restores the previous pill', async () => {
            await typeSearch(''); await settle(600);
            assert.equal(await pill(), 'open', 'Open is restored after clearing the search');
        });

        await S.run('a filter-only empty state says "No tasks match these filters" with Clear filters (#16690)', async () => {
            // Set the priority filter to 'low': every stub task is 'high', so nothing matches.
            await ev(`(() => { const panel = document.querySelector('#team-panel-tasks .list-bar-toggle'); if (panel) panel.click(); return true; })()`); await settle(300);
            await ev(`(() => { const s = document.querySelector('#team-panel-tasks #tk-priority'); if (!s) return false; s.value = 'low'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(800);
            const text = await ev(`document.getElementById('team-panel-tasks').textContent`);
            assert.ok(text.includes('No tasks match these filters'), `says "No tasks match these filters": ${text.slice(0, 200)}`);
            assert.ok(await ev(`!!([...document.querySelectorAll('#team-panel-tasks button')].find(b => b.textContent.trim() === 'Clear filters'))`), 'a Clear filters button is shown');
            // Click Clear filters
            await ev(`([...document.querySelectorAll('#team-panel-tasks button')].find(b => b.textContent.trim() === 'Clear filters')).click(); true`); await settle(600);
            const r2 = await ev(`window.__tp.rows() || []`);
            assert.ok(r2.length > 0, `tasks are back after clearing: ${r2.length}`);
        });

        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
