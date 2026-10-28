// A newcomer's first automation (#10378, Beta tester pass 30): a run row says "See result" and opens the run's chat with a back link to the job; the chat's Resume button says what it resumes; a job that is turned off hides Next
// and says "Turned off", and More says "Turn off" (the button to undo it says "Turn on"); a job a person made sorts above the seeded example. 1280 px, isolated dev server, the jobs and runs stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        const STUB = `(() => {
            const real = window.fetch;
            window.__jobs = [{ id: 7, name: 'morning-motivation', description: 'Example (switched off): would run the daily-motivation workflow every weekday at 9am.', job_type: 'workflow', workflow_id: 3, cron_expr: '0 9 * * 1-5', timezone: 'Local', enabled: 0 },
                { id: 8, name: 'weekday-summary', description: 'Mine', job_type: 'prompt', cron_expr: '0 9 * * 1-5', timezone: 'Local', enabled: 1, repo_path: '/tmp/x', prompt: 'Summarise yesterday', next_fire_at: new Date(Date.now() + 3600000).toISOString() }];
            window.fetch = (input, init = {}) => {
                const u = new URL(String(input && input.url ? input.url : input), location.origin).pathname;
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (u === '/api/scheduled/jobs') return json({ jobs: window.__jobs });
                if (u === '/api/workflows') return json({ workflows: [{ id: 3, name: 'daily-motivation', description: 'Example: x', steps: [], enabled: 1 }] });
                if (/^\\/api\\/scheduled\\/jobs\\/8\\/runs/.test(u)) return json({ runs: [{ id: 21, job_id: 8, status: 'completed', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), session_id: '3f2a9c1e-1111-4222-8333-444455556666' }], total: 1 });
                if (/^\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(u)) return json({ runs: [], total: 0 });
                return real(input, init);
            };
            return true; })()`;
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the two jobs', 10000);
        // 4. what a person made comes first
        assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr .dt-primary')].map(b => b.textContent.trim())`), ['weekday-summary', 'morning-motivation'], 'the person\'s own job is above the seeded example');
        // 3. the job page says Turn off, not Pause, in its main row (#10475; it was in More)
        await ev(`document.querySelector('#group-table-view tbody tr .dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#scheduler-detail .sched-more-btn')`, 'the job page', 8000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-actions > .btn')].map(b => b.textContent.trim())`).then(a => a.filter(t => /^(Turn off|Pause)$/.test(t))), ['Turn off'], 'the main row says Turn off, not Pause');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-more-menu .menu-item')].map(b => b.textContent.trim())`), ['Delete'], 'More holds Delete');
        // 1. See result, and the way back
        await waitFor(`!!document.querySelector('#scheduler-detail [data-on-click="job-run-session"]')`, 'the run row\'s link', 8000);
        assert.equal(await ev(`document.querySelector('#scheduler-detail [data-on-click="job-run-session"]').textContent.trim()`), 'See result');
        await ev(`window.selectHistorySession = async () => true; document.querySelector('#scheduler-detail [data-on-click="job-run-session"]').click(); true`);
        await waitFor(`document.getElementById('history-back') && /weekday-summary/.test(document.getElementById('history-back').textContent) && !document.getElementById('history-back').hidden`, 'the back link to the job', 6000);
        assert.equal(await ev(`document.getElementById('history-back').textContent.trim()`), '← weekday-summary');
        assert.match(await ev(`document.getElementById('btn-resume-session').textContent.trim()`), /^(Resume|Continue) this chat$/, 'the button says which chat it goes on with'); // the word was Resume before #10400
        // and it goes back to the job
        await ev(`document.getElementById('history-back').click(); true`);
        await waitFor(`!!document.querySelector('#scheduler-detail h2') && /weekday-summary/.test(document.querySelector('#scheduler-detail h2').textContent)`, 'the job page again', 8000);
        // 2. a job that is turned off hides Next and says so
        await ev(`import(${S} + 'scheduler.js').then(m => m.selectScheduledJob(7)).then(() => true)`);
        await waitFor(`/morning-motivation/.test(document.querySelector('#scheduler-detail h2')?.textContent || '')`, 'the off job', 8000);
        const off = await ev(`(() => { const dts = [...document.querySelectorAll('#scheduler-detail dt')].map(e => e.textContent.trim()); return { dts, status: document.querySelector('#scheduler-detail .sched-status-line').textContent.trim(), bar: [...document.querySelectorAll('#scheduler-detail .sched-actions > .btn')].map(b => b.textContent.trim()) }; })()`);
        assert.ok(!off.dts.includes('Next'), 'no Next while it is turned off: ' + JSON.stringify(off));
        assert.ok(off.dts.includes('Turned off') && /^Turned off/.test(off.status), 'the page says Turned off: ' + JSON.stringify(off));
        assert.ok(off.bar.includes('Turn on'), 'and the way back is Turn on: ' + JSON.stringify(off));
        console.log('\nPASS first automation: See result, Resume this chat, Turn off, Next hidden when off, own job first');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
