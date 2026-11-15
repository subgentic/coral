// #17186 (walk 51): See result on a run whose agent never wrote a transcript said 'Loading chat...' for good; it says why, in words.
// (copied from the run-now suite's setup) Run now on a job page follows the run to its end (#10104, the retest of #10084 point 6): the page said "waiting to start" and the sidebar's Failed stayed 0 for as long as it was open, because the watch read the job's runs
// but not the jobs, and the job's last result (its words on the page, the Failed count) comes from the list. Through the real Run now button; the server's answers are stubbed (a real run would start an agent).
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
        await ev(`(() => {
            const real = window.fetch; window.__last = null; window.__runs = [];
            const job = () => ({ id: 7, name: 'hello-job', job_type: 'prompt', cron_expr: '0 * * * *', timezone: 'UTC', enabled: 1, repo_path: '/tmp/x', prompt: 'Say hello', next_fire_at: new Date(Date.now() + 3600000).toISOString(), last_run: window.__last });
            window.fetch = (input, init) => {
                const u = String(input && input.url ? input.url : input);
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/scheduled\\/jobs$/.test(u)) return json({ jobs: [job()] });
                if (/\\/api\\/sessions\\/history\\/aaaaaaaa-0000-4000-8000-000000000001/.test(u)) return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/scheduled\\/jobs\\/7\\/run$/.test(u) && init && init.method === 'POST') {
                    const r = { id: 11, job_id: 7, status: 'pending', started_at: new Date().toISOString() };
                    window.__last = r; window.__runs = [r]; return json({ run_id: 11, job_id: 7, status: 'pending' });
                }
                if (/\\/api\\/scheduled\\/jobs\\/7\\/runs/.test(u)) return json({ runs: window.__runs, total: window.__runs.length });
                return real(input, init);
            };
            return true;
        })()`);
        await ev(`window.__runs = [{ id: 11, job_id: 7, status: 'running', session_id: 'aaaaaaaa-0000-4000-8000-000000000001', started_at: new Date(Date.now() - 400000).toISOString() }]; true`);
        await ev(`import(${S} + 'scheduler.js').then(async m => { await m.refreshJobs(); await m.selectScheduledJob(7); return true; })`);
        await waitFor(`!!document.querySelector('[data-on-click="job-run-session"]')`, 'the See result link', 8000);
        await ev(`document.querySelector('[data-on-click="job-run-session"]').click(); true`);
        await waitFor(`!!document.querySelector('#history-messages .history-note')`, 'the chat page says why it has no conversation', 8000);
        const text = await ev(`document.getElementById('history-messages').textContent`);
        assert.doesNotMatch(text, /Loading chat/, 'not stuck on Loading chat: ' + text);
        assert.match(text, /has not written anything/, text);
        assert.ok(await ev(`!!document.querySelector('#history-messages .history-note button')`), 'with Retry while the run is going');
        console.log('PASS See result on a run with no transcript says why');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
