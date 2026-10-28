// The Automations sidebar's counts follow a run as the job page does (#10734, Desktop #10723 moment 5): when a run that was going ends, Running now goes down and Recent runs goes up at once, not at the next 30 second read.
// 1280 px, a stubbed server (one job, its runs), the live run ended through the same tick the page gets (live_jobs.js renderLiveJobs); isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

const STUB = `(() => {
    const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
    const now = new Date().toISOString();
    window.__jobs = [{ id: 1, name: 'nightly-build-job', description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/p', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', consecutive_failures: 0, cron_expr: '0 2 * * *', next_fire_at: new Date(Date.now() + 36e5).toISOString() }];
    window.__runs = [];
    window.fetch = (u, o) => {
        const url = String(u), method = (o && o.method) || 'GET';
        if (method === 'GET' && /\\/api\\/scheduled\\/runs\\/recent/.test(url)) return json({ runs: window.__runs });
        if (method === 'GET' && /\\/api\\/workflows\\/runs\\/recent/.test(url)) return json({ runs: [] });
        if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: window.__jobs });
        if (/\\/api\\/scheduled\\/jobs\\/(\\d+)\\/runs/.test(url)) return json({ runs: [], total: 0 });
        if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const folders = () => ev(`[...document.querySelectorAll('.view-list-item')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('.view-list-item').length >= 4`, 'the folders', 15000);
        // a run is going (the live tick), and the runs were read a moment ago (so the 30 s throttle would hold the next read)
        const run = { id: 77, job_id: 1, job_name: 'nightly-build-job', status: 'running', scheduled_at: new Date().toISOString(), started_at: new Date().toISOString(), trigger_type: 'cron', session_id: 'sess-77' };
        await ev(`import(${S} + 'live_jobs.js').then(m => { m.renderLiveJobs([${JSON.stringify(run)}]); return true; })`);
        await waitFor(`/Running now ?1/.test([...document.querySelectorAll('.view-list-item')].map(b => b.textContent.replace(/\\s+/g, ' ')).join('|'))`, 'Running now 1', 5000);
        assert.ok((await folders()).some(f => /^Recent runs ?0?$/.test(f)), `Recent runs has nothing yet: ${JSON.stringify(await folders())}`);
        // the run ends: the server has it finished and unread; the tick says nothing is running
        await ev(`window.__runs = [{ id: 77, job_id: 1, job_name: 'nightly-build-job', status: 'completed', scheduled_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString(), trigger_type: 'cron' }]; import(${S} + 'live_jobs.js').then(m => { m.renderLiveJobs([]); return true; })`);
        await waitFor(`/Recent runs ?1\\b/.test([...document.querySelectorAll('.view-list-item')].map(b => b.textContent.replace(/\\s+/g, ' ')).join('|'))`, 'Recent runs 1 within 2 s, not at the next 30 s read', 2500);
        const after = await folders();
        assert.ok(!after.some(f => /^Running now\s*[1-9]/.test(f)), `Running now is down: ${JSON.stringify(after)}`);
        console.log('PASS Automations counts follow a run');
    } finally { await Page.close?.(); }
})().catch(e => { console.error(e); process.exit(1); });
