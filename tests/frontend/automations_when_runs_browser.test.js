// When a scheduled job runs (#10515, Desktop pass): the New job form and a job's page say it as the scheduler does (only while Coral is running on this computer; a run missed while it was off happens once when it
// starts again). 1280 px, isolated dev server, the jobs stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        const STUB = `(() => {
            const real = window.fetch;
            window.__jobs = [{ id: 8, name: 'weekday-summary', description: 'Mine', job_type: 'prompt', cron_expr: '0 9 * * 1-5', timezone: 'Local', enabled: 1, repo_path: '/tmp/x', prompt: 'Summarise yesterday', next_fire_at: new Date(Date.now() + 3600000).toISOString() }];
            window.fetch = (input, init = {}) => {
                const u = new URL(String(input && input.url ? input.url : input), location.origin).pathname;
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (u === '/api/scheduled/jobs') return json({ jobs: window.__jobs });
                if (u === '/api/workflows') return json({ workflows: [] });
                if (/^\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(u)) return json({ runs: [], total: 0 });
                return real(input, init);
            };
            return true; })()`;
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, 'the job', 10000);
        // the job's page
        await ev(`document.querySelector('#group-table-view tbody tr .dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#scheduler-detail .sched-facts')`, 'the job page', 8000);
        const row = await ev(`(() => { const dt = [...document.querySelectorAll('#scheduler-detail .sched-facts dt')].find(d => d.textContent.trim() === 'Runs'); return dt ? dt.nextElementSibling.textContent.trim() : null; })()`);
        assert.equal(row, 'Only while Coral is running on this computer. A run missed while Coral was off happens once when it starts again.', 'the job page says when it runs');
        // the New job form
        await ev(`document.querySelector('#scheduler-detail .back-link, #scheduler-detail .sched-back')?.click(); true`);
        await ev(`(window.openJobForm || window.showJobModal || (() => {}))(); true`);
        await ev(`document.querySelector('[data-on-click="job-new"]')?.click(); true`);
        await waitFor(`!!document.querySelector('.sched-when-note')`, 'the form\'s note', 8000);
        assert.equal(await ev(`document.querySelector('.sched-when-note').textContent.trim()`), 'Runs only while Coral is running on this computer. A run missed while Coral was off happens once when it starts again.', 'the form says when it runs');
        console.log('PASS automations_when_runs');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
