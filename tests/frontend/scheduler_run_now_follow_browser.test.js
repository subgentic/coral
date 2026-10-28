// Run now on a job page follows the run to its end (#10104, the retest of #10084 point 6): the page said "waiting to start" and the sidebar's Failed stayed 0 for as long as it was open, because the watch read the job's runs
// but not the jobs, and the job's last result (its words on the page, the Failed count) comes from the list. Through the real Run now button; the server's answers are stubbed (a real run would start an agent).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => {
            const real = window.fetch; window.__last = null; window.__runs = [];
            const job = () => ({ id: 7, name: 'hello-job', job_type: 'prompt', cron_expr: '0 * * * *', timezone: 'UTC', enabled: 1, repo_path: '/tmp/x', prompt: 'Say hello', next_fire_at: new Date(Date.now() + 3600000).toISOString(), last_run: window.__last });
            window.fetch = (input, init) => {
                const u = String(input && input.url ? input.url : input);
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/scheduled\\/jobs$/.test(u)) return json({ jobs: [job()] });
                if (/\\/api\\/scheduled\\/jobs\\/7\\/run$/.test(u) && init && init.method === 'POST') {
                    const r = { id: 11, job_id: 7, status: 'pending', started_at: new Date().toISOString() };
                    window.__last = r; window.__runs = [r]; return json({ run_id: 11, job_id: 7, status: 'pending' });
                }
                if (/\\/api\\/scheduled\\/jobs\\/7\\/runs/.test(u)) return json({ runs: window.__runs, total: window.__runs.length });
                return real(input, init);
            };
            return true;
        })()`);
        await ev(`import(${S} + 'scheduler.js').then(async m => { await m.refreshJobs(); await m.selectScheduledJob(7); return true; })`);
        const detail = () => ev(`document.getElementById('scheduler-detail')?.textContent || ''`);
        await waitFor(`!!document.querySelector('#scheduler-detail [data-on-click="job-run-now"]')`, 'the Run now button', 8000);
        await ev(`document.querySelector('#scheduler-detail [data-on-click="job-run-now"]').click(); true`);
        await waitFor(`/waiting to start/i.test(document.getElementById('scheduler-detail')?.textContent || '')`, 'the page says the run is waiting to start', 8000);
        // the run ends in failure on the server
        await ev(`(() => { const f = { id: 11, job_id: 7, status: 'failed', error_msg: 'agent did not start', started_at: new Date().toISOString(), finished_at: new Date().toISOString() }; window.__last = f; window.__runs = [f]; return true; })()`);
        await waitFor(`!/waiting to start/i.test(document.getElementById('scheduler-detail')?.textContent || '')`, 'the page follows the run past "waiting to start" without a reload', 9000);
        assert.match(await detail(), /failed/i, 'and says it failed: ' + (await detail()).slice(0, 300));
        const failedCount = await ev(`(document.querySelector('.view-list-item[data-key="failed"]')?.textContent || '').replace(/\\s+/g, ' ').trim()`);
        assert.match(failedCount, /^Failed\s*1$/, 'the sidebar counts the failed run: ' + failedCount);
        console.log('PASS Run now: the page and the sidebar follow the run to Failed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
