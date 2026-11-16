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
                if (/^\\/api\\/scheduled\\/jobs\\/8\\/runs/.test(u)) return json({ runs: [
                    { id: 21, job_id: 8, status: 'completed', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), session_id: '3f2a9c1e-1111-4222-8333-444455556666' },
                    { id: 22, job_id: 8, status: 'running', started_at: new Date().toISOString(), session_id: '3f2a9c1e-2222-4222-8333-444455556666' },
                    { id: 23, job_id: 8, status: 'failed', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), error_msg: 'The job\\'s prompt was never typed: the agent stayed on a question (such as trusting the folder) or was not ready for it. Run the job again and answer the question when it shows in Needs you.', error_code: 'prompt_not_typed', session_id: '3f2a9c1e-3333-4222-8333-444455556666' },
                    { id: 24, job_id: 8, status: 'completed', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), session_id: '3f2a9c1e-4444-4222-8333-444455556666', result_text: 'Summary: 3 files changed <b>not markup</b>, tests pass.' }], total: 4 });
                if (/^\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(u)) return json({ runs: [], total: 0 });
                return real(input, init);
            };
            return true; })()`;
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await require('./helpers/wait').coralReady(ev);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the two jobs', 10000);
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr .dt-primary')].find(b => /weekday-summary/.test(b.textContent)).click(); true`);
        await waitFor(`document.querySelectorAll('#scheduler-detail [data-on-click="job-run-session"]').length === 3`, 'See result on the three runs that ended', 8000);
        assert.equal(await ev(`!!document.querySelector('#scheduler-detail [data-on-click="job-run-session"][data-session-id^="3f2a9c1e-2222"]')`), false, 'a run still going offers no See result');
        const WORDS = { 21: /this run finished, but its chat was not kept\./, 23: /this run failed before it had a chat: The job's prompt was never typed/ };
        for (const [id, want] of Object.entries(WORDS)) {
            await ev(`document.querySelectorAll('.toast-message').forEach(t => t.remove()); true`);
            const sid = { 21: '3f2a9c1e-1111', 23: '3f2a9c1e-3333' }[id];
            await ev(`document.querySelector('#scheduler-detail [data-on-click="job-run-session"][data-session-id^="${sid}"]').click(); true`);
            await waitFor(`/this run (finished|failed)/.test(document.body.textContent)`, `run ${id}: the toast says why`, 6000);
            await waitFor(`/weekday-summary/.test(document.querySelector('#scheduler-detail h2')?.textContent || '') && !document.getElementById('history-session-view')?.offsetParent`, `run ${id}: back on the job page, the chat page gone`, 6000);
            assert.match(await ev(`document.body.textContent`), want, `run ${id}: worded by its status`);
            assert.ok(!/If it is still running/.test(await ev(`document.body.textContent`)), `run ${id}: no 'if it is still running' for a run whose status is known`);
            assert.ok(!/Loading chat/.test(await ev(`document.getElementById('history-session-view')?.offsetParent ? document.getElementById('history-session-view').textContent : ''`)), `run ${id}: not left on Loading chat`);
        }
        // #16958: a finished run with a result_text on its record shows what its agent said last, as plain text, when its chat is gone
        await ev(`document.querySelector('#scheduler-detail [data-on-click="job-run-session"][data-session-id^="3f2a9c1e-4444"]').click(); true`);
        await waitFor(`!!document.querySelector('#run-result-dialog[open] #run-result-text')`, 'the run result dialog', 6000);
        assert.equal(await ev(`document.querySelector('#run-result-text').textContent`), 'Summary: 3 files changed <b>not markup</b>, tests pass.', 'the text is shown as written');
        assert.equal(await ev(`document.querySelectorAll('#run-result-text b').length`), 0, 'and never as markup');
        console.log('\nPASS See result with no chat goes back to the job and says why');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
