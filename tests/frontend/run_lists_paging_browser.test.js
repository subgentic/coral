// A job's and a workflow's run history says how many runs there are and reads the older ones (#8089: the job page showed the newest 20 and the workflow page the newest 10 and said nothing of the rest).
// The runs answers are stubbed with the server's shape (limit, offset and total); a job with 45 runs and a workflow with 25. 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
                const at = i => new Date(Date.now() - i * 3600000).toISOString();
                const jobRuns = Array.from({ length: 45 }, (_, i) => ({ id: 1000 - i, job_id: 1, status: 'completed', exit_reason: 'completed', scheduled_at: at(i + 1), started_at: at(i + 1), finished_at: at(i + 1) }));
                const wfRuns = Array.from({ length: 25 }, (_, i) => ({ id: 500 - i, workflow_id: 1, status: 'completed', trigger_type: 'manual', started_at: at(i + 1), finished_at: at(i + 1), duration_seconds: 60, steps: [] }));
                const page = (rows, url) => { const q = new URL(url, location.origin).searchParams; const lim = Number(q.get('limit') || 20), off = Number(q.get('offset') || 0); window.__asked.push(url); return json({ runs: rows.slice(off, off + lim), total: rows.length }); };
                window.__asked = [];
                const job = { id: 1, name: 'many-runs', description: '', cron_expr: '0 * * * *', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/repo', base_branch: 'main', prompt: 'Tidy.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', job_type: 'prompt', created_at: at(99), updated_at: at(99), last_run: jobRuns[0] };
                const wf = { id: 1, name: 'many-wf', description: '', repo_path: '/work/repo', base_branch: 'main', max_duration_s: 3600, cleanup_worktree: 1, enabled: 1, created_at: at(99), updated_at: at(99), steps: [{ name: 'Only', type: 'shell', command: 'true' }], step_count: 1, last_run: wfRuns[0] };
                window.fetch = (u, o) => { const url = String(u), m = (o && o.method) || 'GET';
                    if (m === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: [job] });
                    if (m === 'GET' && /\\/api\\/scheduled\\/jobs\\/1\\/runs/.test(url)) return page(jobRuns, url);
                    if (m === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [wf] });
                    if (m === 'GET' && /\\/api\\/workflows\\/1$/.test(url)) return json(wf);
                    if (m === 'GET' && /\\/api\\/workflows\\/1\\/runs/.test(url)) return page(wfRuns, url);
                    return real(u, o); };
                return true; })()`);
            const rows = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)} + ' tbody tr:not(.dt-group)').length`);
            const foot = (sel) => ev(`(() => { const f = document.querySelector(${JSON.stringify(sel)} + ' .dt-foot'); return f ? { text: f.querySelector('.dt-foot-text').textContent, more: (f.querySelector('.dt-more') || {}).textContent || '' } : null; })()`);
            const clickMore = (sel) => ev(`document.querySelector(${JSON.stringify(sel)} + ' .dt-more').click(); true`);

            // a job with 45 runs
            await ev(`import(${S} + 'scheduler.js').then(m => { window.__sched = m; return true; })`);
            await ev(`window.switchNavTab('automations'); window.__sched.refreshJobs().then(() => true)`);
            await waitFor(`window.__sched.jobList().length > 0`, 'the job', 8000);
            await ev(`window.__sched.selectScheduledJob(window.__sched.jobList()[0].id).then(() => true)`);
            const T = '#sched-run-history';
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 20`, `${tag}: the first 20 runs`, 8000);
            assert.deepEqual(await foot(T), { text: 'Showing the newest 20 of 45 runs', more: 'Show older runs' }, `${tag}: the job page says there are more`);
            await clickMore(T);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 40`, `${tag}: 40 runs after one click`, 8000);
            assert.equal((await foot(T)).text, 'Showing the newest 40 of 45 runs');
            await clickMore(T);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 45`, `${tag}: all 45 runs`, 8000);
            assert.equal(await foot(T), null, `${tag}: with every run shown the footer is gone`);
            assert.ok((await ev(`window.__asked.filter(u => /offset=40/.test(u)).length`)) === 1 && (await ev(`window.__asked.some(u => /offset=20/.test(u))`)), `${tag}: the older runs were asked for by offset: ` + (await ev(`window.__asked.join(' ')`)));

            // a workflow with 25 runs
            await ev(`window.openAutomationsFolder('workflows'); true`);
            await ev(`Promise.resolve(window.selectWorkflow(1)).then(() => true)`);
            const W = '#wf-run-table';
            await waitFor(`document.querySelectorAll('${W} tbody tr:not(.dt-group)').length === 10`, `${tag}: the first 10 workflow runs`, 8000);
            assert.deepEqual(await foot(W), { text: 'Showing the newest 10 of 25 runs', more: 'Show older runs' }, `${tag}: the workflow page says there are more`);
            await clickMore(W); await waitFor(`document.querySelectorAll('${W} tbody tr:not(.dt-group)').length === 20`, `${tag}: 20 workflow runs`, 8000);
            await clickMore(W); await waitFor(`document.querySelectorAll('${W} tbody tr:not(.dt-group)').length === 25`, `${tag}: all 25 workflow runs`, 8000);
            assert.equal(await foot(W), null, `${tag}: with every run shown the footer is gone`);
            assert.equal(await ev(`new Set([...document.querySelectorAll('${W} tbody tr:not(.dt-group)')].map(r => r.dataset.key)).size`), 25, `${tag}: no run is shown twice`);
            console.log(`PASS ${tag}: a job's and a workflow's runs say how many there are and read the older ones`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
