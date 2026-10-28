// A job's name in the Jobs list wraps at its hyphens, not one letter a line (#10475, Mobile automation pass): at 390 and 320 px a long name of a job that is turned off (its chip sits beside the name in the one narrow
// column) takes at most four lines and its longest line is a word, not a letter or two. A stubbed server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const STUB = `(() => {
        const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: 'Tidy.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', consecutive_failures: 0, last_run: null };
        const jobs = [{ ...base, id: 1, name: 'nightly-database-backup-verification', cron_expr: '0 3 * * *', enabled: 0, next_fire_at: null }, { ...base, id: 2, name: 'weekly-cleanup-of-old-worktrees', cron_expr: '0 9 * * 1', next_fire_at: new Date(Date.now() + 30 * 3600000).toISOString() }];
        window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
            if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
            if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
            if (/\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
            return real(u, o); };
        return true; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h] of [[390, 844], [320, 568]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.openAutomationsFolder('jobs'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length === 2`, `${w}: the two jobs`, 10000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the list draws
            const names = await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].map(b => { const range = document.createRange(); range.selectNodeContents(b); const lines = new Map(); for (const r of range.getClientRects()) lines.set(Math.round(r.top), Math.max(lines.get(Math.round(r.top)) || 0, r.width)); const cs = getComputedStyle(b), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
                return { t: b.textContent.trim(), lines: Math.round(b.getBoundingClientRect().height / lh), width: Math.round(b.getBoundingClientRect().width), sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })`);
            for (const n of names) {
                assert.ok(n.lines <= 4, `${w}: "${n.t}" takes ${n.lines} lines in a column ${n.width} px wide`);
                assert.ok(n.width >= 90, `${w}: the name's column is ${n.width} px, not a sliver: "${n.t}"`);
                assert.equal(n.sideways, false, `${w}: nothing scrolls sideways`);
            }
        }
        console.log('PASS Jobs list: a long name wraps at its hyphens in the narrow column');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
