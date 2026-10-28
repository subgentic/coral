// The Failed list says why (#9965, Beta Tester pass 3 point 6): a job whose last run failed shows its chip and, beside it, why in words, instead of "Failed" alone: a run that could not start the agent
// ("couldn't start the agent: claude: command not found"), a step that exited ("step 2 (Test) exited with 3"), Coral restarting. A job that passed has no reason. 1280 px, a stubbed server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => {
            const real = window.fetch; const ago = h => new Date(Date.now() - h * 3600000).toISOString();
            const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/p', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', cron_expr: '0 * * * *' };
            const jobs = [
                { ...base, id: 1, name: 'no-cli-job', last_run: { id: 11, status: 'failed', exit_reason: 'start_command_failed', error_msg: 'claude: command not found', started_at: ago(1), finished_at: ago(1) } },
                { ...base, id: 2, name: 'step-job', last_run: { id: 12, status: 'failed', error_msg: 'step 2 (Test) failed: exit code 3', started_at: ago(2), finished_at: ago(2) } },
                { ...base, id: 3, name: 'restart-job', last_run: { id: 13, status: 'failed', exit_reason: 'interrupted_by_restart', started_at: ago(3), finished_at: ago(3) } },
                { ...base, id: 4, name: 'fine-job', last_run: { id: 14, status: 'completed', started_at: ago(4), finished_at: ago(4) } },
            ];
            const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url ? u.url : u);
                if (/\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
                if (/\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
                if (/\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
                return real(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('automations'); import((window.__coralStatic || '/static/') + 'scheduler.js').then(m => m.refreshJobs()).then(() => true)`);
        await ev(`Promise.resolve(window.navigateTo ? window.navigateTo('/automations/failed') : (history.pushState({}, '', '/automations/failed'), window.dispatchEvent(new PopStateEvent('popstate')))).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 3`, 'the Failed list', 12000);
        const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => ({ name: r.querySelector('.dt-primary')?.textContent.trim(), last: (r.querySelector('td[data-key="last-run"]') || r).textContent.replace(/\\s+/g, ' ').trim() }))`);
        const by = n => (rows.find(r => r.name === n) || {}).last || '';
        assert.match(by('no-cli-job'), /Failed.*couldn't start the agent: claude: command not found/, 'a run that could not start the agent says so: ' + JSON.stringify(rows));
        assert.match(by('step-job'), /Failed.*step 3 \(Test\) exited with 3/, 'a failed step says which and how: ' + JSON.stringify(rows));
        assert.match(by('restart-job'), /Failed.*Coral restarted/, 'a run Coral restarted says so: ' + JSON.stringify(rows));
        assert.equal(by('fine-job'), '', 'a job that passed is not in the Failed list');
        console.log('PASS the Failed list says why a run failed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
