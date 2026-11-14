// #16770 (walk 32 F1): See result on a run whose chat cannot be opened (the run has a session id but no saved chat: the server answers 404) must not leave the page on 'Loading chat…' with the title 'Chat':
// it goes back to the job and says why. The jobs and run rows are stubbed; the chat route and selectHistorySession are the real ones. 1280 px, isolated dev server.
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
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await require('./helpers/wait').coralReady(ev);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the two jobs', 10000);
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr .dt-primary')].find(b => /weekday-summary/.test(b.textContent)).click(); true`);
        await waitFor(`!!document.querySelector('#scheduler-detail [data-on-click="job-run-session"]')`, 'See result', 8000);
        await ev(`document.querySelector('#scheduler-detail [data-on-click="job-run-session"]').click(); true`);
        await waitFor(`/this run has no chat to show/.test(document.body.textContent)`, 'the toast says why', 6000);
        await waitFor(`/weekday-summary/.test(document.querySelector('#scheduler-detail h2')?.textContent || '') && !document.getElementById('history-session-view')?.offsetParent`, 'back on the job page, the chat page gone', 6000);
        assert.match(await ev(`document.body.textContent`), /this run has no chat to show/, 'it says why');
        assert.ok(!/Loading chat/.test(await ev(`document.getElementById('history-session-view')?.offsetParent ? document.getElementById('history-session-view').textContent : ''`)), 'not left on Loading chat');
        console.log('\nPASS See result with no chat goes back to the job and says why');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
