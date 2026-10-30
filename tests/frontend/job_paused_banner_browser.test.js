// A paused job's failure banner (#7177, from Codex Test's #7158): "The last 3 runs failed ... It is still scheduled." was said of a job that is paused. A paused job says it is paused and what resumes it
// (Enable); one the scheduler paused after repeated failures says to fix the cause first; an enabled job keeps "It is still scheduled." Drives Chrome over CDP through agent_view_harness.js with the jobs
// answered at the page's fetch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const real = window.fetch; const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            const ago = h => new Date(Date.now() - h * 3600000).toISOString(); const nxt = h => new Date(Date.now() + h * 3600000).toISOString();
            const fail = id => ({ id, status: 'failed', exit_reason: 'agent_error', error_msg: 'the agent exited with 1', started_at: ago(id), finished_at: ago(id - 0.1) });
            const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/repo', base_branch: 'main', prompt: 'Tidy.', max_duration_s: 3600, cleanup_worktree: 0, flags: '', job_type: 'prompt', cron_expr: '0 2 * * *', last_run: fail(2), consecutive_failures: 3 };
            window.__jobs = [ { ...base, id: 1, name: 'live-job', enabled: 1, next_fire_at: nxt(9) }, { ...base, id: 2, name: 'paused-by-hand', enabled: 0, next_fire_at: null }, { ...base, id: 3, name: 'paused-by-failures', enabled: 0, next_fire_at: null, paused_reason: 'it failed 3 times in a row' } ];
            window.fetch = (u, o) => { const url = String(u), m = (o && o.method) || 'GET';
                if (m === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: window.__jobs });
                if (/\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [] });
                return real(u, o); };
            return true; })()`);
        await ev(`import(${S} + 'scheduler.js').then(m => { window.__sched = m; return true; })`);
        await ev(`window.switchNavTab('automations'); window.__sched.refreshJobs().then(() => true)`);
        await waitFor(`window.__sched.jobList().length === 3`, 'three jobs', 10000);
        const banner = async idx => {
            await ev(`window.__sched.selectScheduledJob(${idx + 1}).then(() => true)`); // the jobs' ids in the stub are 1 to 3
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-fail-banner') && document.querySelector('#scheduler-detail h2').textContent === ${JSON.stringify(['live-job', 'paused-by-hand', 'paused-by-failures'][idx])}`, 'the job page', 8000);
            return ev(`document.querySelector('#scheduler-detail .sched-fail-banner').textContent.replace(/\\s+/g, ' ').trim()`);
        };
        const live = await banner(0), hand = await banner(1), auto = await banner(2);
        assert.match(live, /It is still scheduled\./, 'an enabled job is still scheduled: ' + live);
        assert.ok(!/still scheduled/.test(hand) && /It is paused\. Press Enable to run it again\./.test(hand), 'a job paused by hand says it is paused and what resumes it: ' + hand);
        assert.ok(!/still scheduled/.test(auto) && /It is paused\. Fix the cause, then press Enable\./.test(auto), 'a job the scheduler paused says to fix the cause first: ' + auto);
        console.log('PASS job paused banner');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
