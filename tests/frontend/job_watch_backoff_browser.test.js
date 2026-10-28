// A run that stays pending is not read every 3 s for ever (#10120, Security Reviewer's LOW on #10104): after about two minutes the job page reads every 30 s, says "Still waiting to start" with a Refresh that reads now and starts
// the fast pace again. A fake clock moves Date.now forward; the delays the page asks for are recorded. Isolated dev server; the jobs list and the runs are stubbed.
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
            const real = window.fetch, realNow = Date.now, realSet = window.setTimeout; window.__skew = 0; window.__delays = []; window.__runReads = 0;
            Date.now = () => realNow() + window.__skew;
            window.setTimeout = (fn, ms, ...a) => { if (ms === 3000 || ms === 30000) window.__delays.push(ms); return realSet(fn, ms, ...a); };
            const job = { id: 7, name: 'hello-job', job_type: 'prompt', cron_expr: '0 * * * *', timezone: 'UTC', enabled: 1, repo_path: '/tmp/x', prompt: 'Say hello', next_fire_at: new Date(Date.now() + 3600000).toISOString(), last_run: { id: 11, status: 'pending' } };
            window.fetch = (input, init) => {
                const u = String(input && input.url ? input.url : input);
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/scheduled\\/jobs$/.test(u)) return json({ jobs: [job] });
                if (/\\/api\\/scheduled\\/jobs\\/7\\/runs/.test(u)) { window.__runReads++; return json({ runs: [{ id: 11, status: 'pending', started_at: new Date().toISOString() }], total: 1 }); }
                return real(input, init);
            };
            return true;
        })()`);
        await ev(`import(${S} + 'scheduler.js').then(async m => { await m.refreshJobs(); await m.selectScheduledJob(7); return true; })`);
        await waitFor(`/Waiting to start/.test(document.getElementById('scheduler-detail')?.textContent || '')`, 'the pending run', 8000);
        assert.equal(await ev(`window.__delays.at(-1)`), 3000, 'a new pending run is read every 3 s');
        assert.equal(await ev(`!!document.getElementById('sched-still-waiting')`), false, 'and the page says nothing more yet');
        // two minutes and more go by: the next read schedules the slow pace
        const before = await ev(`window.__runReads`);
        await ev(`window.__skew = 130000; true`);
        await waitFor(`window.__runReads > ${before} && window.__delays.at(-1) === 30000`, 'the watch backs off to 30 s', 12000);
        await waitFor(`!!document.getElementById('sched-still-waiting')`, 'the note', 4000);
        assert.match(await ev(`document.getElementById('sched-still-waiting').textContent`), /^Still waiting to start\. Refresh$/);
        // Refresh reads now, and the fast pace is back
        const n = await ev(`window.__runReads`);
        await ev(`[...document.querySelectorAll('#sched-still-waiting button')].find(b => b.textContent === 'Refresh').click(); true`);
        await waitFor(`window.__runReads > ${n}`, 'Refresh reads at once', 3000);
        await waitFor(`window.__delays.at(-1) === 3000 && !document.getElementById('sched-still-waiting')`, 'the fast pace again, the note gone', 6000);
        console.log('\nPASS a pending run backs off to 30 s, says so, and Refresh brings the fast pace back');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
