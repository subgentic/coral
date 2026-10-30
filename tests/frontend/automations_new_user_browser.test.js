// Two things a new user hit in Automations (Beta Tester pass 3, #9958). The job page keeps saying "Waiting to start" for a run the sidebar already lists as Failed: the page read its runs once, so it now reads them
// again every 3 s while one is pending or running. And a new Agent-prompt job's Repository path is not the home folder: the Settings default, else empty and required (as New Agent has it, #5989).
// Isolated dev server; the jobs list and the job's runs are stubbed through fetch (a real run would start an agent).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        // 1. the runs refresh
        await ev(`(() => {
            const real = window.fetch; window.__runs = [{ id: 11, status: 'pending', started_at: new Date().toISOString() }]; window.__runReads = 0;
            const job = { id: 7, name: 'hello-job', job_type: 'prompt', cron_expr: '0 * * * *', timezone: 'UTC', enabled: 1, repo_path: '/tmp/x', prompt: 'Say hello', next_fire_at: new Date(Date.now() + 3600000).toISOString() };
            window.fetch = (input, init) => {
                const u = String(input && input.url ? input.url : input);
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/scheduled\\/jobs$/.test(u)) return json({ jobs: [job] });
                if (/\\/api\\/scheduled\\/jobs\\/7\\/runs/.test(u)) { window.__runReads++; if (window.__runsFail) return Promise.reject(new TypeError('Failed to fetch')); return json({ runs: window.__runs, total: window.__runs.length }); }
                return real(input, init);
            };
            return true;
        })()`);
        await ev(`import(${S} + 'scheduler.js').then(async m => { await m.refreshJobs(); await m.selectScheduledJob(7); return true; })`);
        await waitFor(`/Waiting to start/.test(document.getElementById('scheduler-detail')?.textContent || '')`, 'the run says Waiting to start', 8000);
        await ev(`window.__runs = [{ id: 11, status: 'failed', started_at: new Date().toISOString(), finished_at: new Date().toISOString() }]; true`);
        await waitFor(`/Failed/.test(document.getElementById('scheduler-detail')?.textContent || '') && !/Waiting to start/.test(document.getElementById('scheduler-detail')?.textContent || '')`, 'the page follows the run to Failed without being reopened', 9000);
        console.log('PASS the job page follows a run from Waiting to start to Failed');
        // the watch survives a read that fails: the page keeps what it shows, reads again, and follows the run when the server answers (QA Reviewer 2)
        await ev(`window.__runs = [{ id: 12, status: 'pending', started_at: new Date().toISOString() }]; Promise.resolve(window.__reopen = true); true`);
        await ev(`import(${S} + 'scheduler.js').then(m => m.selectScheduledJob(7)).then(() => true)`);
        await waitFor(`/Waiting to start/.test(document.getElementById('scheduler-detail')?.textContent || '')`, 'a pending run again', 8000);
        await ev(`window.__runsFail = true; window.__failedReads = window.__runReads; true`);
        await waitFor(`window.__runReads - window.__failedReads >= 2`, 'two reads while the server is down: it keeps reading', 12000);
        assert.match(await ev(`document.getElementById('scheduler-detail').textContent`), /Waiting to start/, 'the page keeps the run it showed while the read fails');
        await ev(`window.__runsFail = false; window.__runs = [{ id: 12, status: 'failed', started_at: new Date().toISOString(), finished_at: new Date().toISOString() }]; true`);
        await waitFor(`/Failed/.test(document.getElementById('scheduler-detail')?.textContent || '') && !/Waiting to start/.test(document.getElementById('scheduler-detail')?.textContent || '')`, 'and follows the run once the server answers', 9000);
        console.log('PASS the watch survives a failed read');
        // 2. the Repository path of a new Agent-prompt job: no home folder
        const repoAfterOpening = async setting => {
            await ev(`import(${S} + 'state.js').then(m => { m.state.settings = { ...(m.state.settings || {}), default_working_dir: ${JSON.stringify(setting)} }; return true; })`);
            await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('job-modal-repo')`, 'the New job dialog', 8000);
            await ev(`(() => { const b = [...document.querySelectorAll('#job-type-toggle button')].find(x => x.dataset.type === 'prompt'); if (b) b.click(); return true; })()`);
            const v = await ev(`document.getElementById('job-modal-repo').value`);
            await ev(`window.hideJobModal(); true`);
            return v;
        };
        assert.equal(await repoAfterOpening(''), '', 'no Settings default: the Repository path is empty and required, not the home folder');
        assert.equal(await repoAfterOpening('/work/payments'), '/work/payments', 'with a Settings default it is that folder');
        console.log('PASS a new job does not start on the home folder');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
