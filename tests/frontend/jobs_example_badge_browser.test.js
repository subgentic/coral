// The Example badge of the seeded job is not clipped by its cell or the row's border (#11051, the phone smoke of v2.0.4) at 390 px, at 100% and 200% text; the name and the badge sit inside the cell.
// (stub: the Jobs list of jobs_name_wrap_browser.test.js) A stubbed server. Drives Chrome over CDP through agent_view_harness.js.
// was: 
// beside its name (67 px of a 148 px cell: the Mobile Beta Tester's measure), takes at most four lines and its longest line is a word, not a letter or two. A stubbed server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const STUB = `(() => {
        const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: 'Tidy.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', consecutive_failures: 0, last_run: null };
        const jobs = [{ ...base, id: 1, name: 'nightly-database-backup-verification', cron_expr: '0 3 * * *', enabled: 0, next_fire_at: null }, { ...base, id: 2, name: 'weekly-cleanup-of-old-worktrees', cron_expr: '0 9 * * 1', next_fire_at: new Date(Date.now() + 30 * 3600000).toISOString() },
            { ...base, id: 3, name: 'morning-motivation', description: 'Example (switched off): would run the daily-motivation workflow every weekday at 9am. Turn it on to try it.', cron_expr: '0 9 * * 1-5', enabled: 0, next_fire_at: null }];
        window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
            if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
            if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
            if (/\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
            return real(u, o); };
        return true; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, fs] of [[390, 844, 16], [390, 844, 32]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`document.documentElement.style.fontSize = '${fs}px'; window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.openAutomationsFolder('jobs'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length === 3 && !!document.querySelector('#group-table-view .dt-tag')`, `${w}@${fs}: the jobs and the badge`, 10000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the list draws
            const m = await ev(`(() => { const tag = document.querySelector('#group-table-view .dt-tag'), td = tag.closest('td'), tr = tag.closest('tr'), a = tag.getBoundingClientRect(), c = td.getBoundingClientRect(), r = tr.getBoundingClientRect(), box = tag.closest('.dt-box') || td;
                return { tag: [Math.round(a.left), Math.round(a.right), Math.round(a.top), Math.round(a.bottom)], cell: [Math.round(c.left), Math.round(c.right), Math.round(c.top), Math.round(c.bottom)], row: [Math.round(r.left), Math.round(r.right), Math.round(r.top), Math.round(r.bottom)], overflowX: getComputedStyle(td).overflowX, tdScroll: td.scrollWidth - td.clientWidth }; })()`);
            console.log(`   ${w}@${fs}: ` + JSON.stringify(m));
            assert.ok(m.tag[0] >= m.cell[0] - 1 && m.tag[1] <= m.cell[1] + 1, `${w}@${fs}: the badge is inside its cell sideways: ` + JSON.stringify(m));
            assert.ok(m.tag[2] >= m.row[2] && m.tag[3] <= m.row[3] - 4, `${w}@${fs}: the badge ends 4 px or more above the row's bottom border, as the name sits below the row's top (it touched the border): ` + JSON.stringify(m));
        }
        console.log('PASS the Example badge is whole at 390 px, at 100% and 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
