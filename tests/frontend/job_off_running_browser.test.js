// A turned-off job with a run still going says so plainly, and the Recent runs number says what it counts (#17572, walk 74 L17, L20): the job page read "Turned off · running now" (a contradiction), and
// Recent runs said 0 beside Running now 1. Now the status says the last run is still going and no new run will start; the Recent runs row says it counts finished runs not opened yet. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const ago = s => new Date(Date.now() - s * 1000).toISOString();
                const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/repo', base_branch: 'main', prompt: 'Tidy.', max_duration_s: 3600, cleanup_worktree: 0, flags: '', job_type: 'prompt', cron_expr: '0 2 * * *', next_fire_at: ago(-3600), consecutive_failures: 0 };
                const run = { id: 2, status: 'running', session_id: 'sess-1', scheduled_at: ago(300), started_at: ago(300) };
                window.__jobs = [{ ...base, id: 1, name: 'off-but-going', enabled: 0, last_run: run }, { ...base, id: 2, name: 'on-and-going', enabled: 1, last_run: { ...run, id: 3 } }];
                window.fetch = (u, o) => { const url = String(u), m = (o && o.method) || 'GET';
                    if (m === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: window.__jobs });
                    if (/\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [run], total: 1 });
                    if (m === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
                    return real(u, o); };
                return true; })()`);
            await ev(`import(${S} + 'scheduler.js').then(m => { window.__sched = m; return true; })`);
            await ev(`window.switchNavTab('automations'); window.__sched.refreshJobs().then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 2`, `${w}: the job rows`, 8000);
            await ev(`window.__sched.selectScheduledJob(1).then(() => true)`);
            await waitFor(`/Turned off/.test(document.body.innerText)`, `${w}: the off job's page`, 6000);
            const page = await ev(`document.body.innerText.replace(/\\s+/g, ' ')`);
            assert.match(page, /Turned off · the last run is still going; no new runs will start/, `${w}: the page says what is going on`);
            assert.doesNotMatch(page, /Turned off · running now/, `${w}: no contradiction`);
            await ev(`window.__sched.selectScheduledJob(2).then(() => true)`);
            await waitFor(`/Active/.test(document.body.innerText)`, `${w}: the on job's page`, 6000);
            assert.match(await ev(`document.body.innerText.replace(/\\s+/g, ' ')`), /Active · running now/, `${w}: an active job still says running now`);
            const recent = await ev(`(() => { const b = [...document.querySelectorAll('#automations-folders button, #automations-folders [role=option], .view-list button')].find(x => /^Recent runs/.test(x.textContent.trim()) || /^Recent runs/.test(x.getAttribute('aria-label') || '')); return b ? { label: b.getAttribute('aria-label') || '', title: b.title || '' } : null; })()`);
            if (!mobile) {
                assert.ok(recent, `${w}: the Recent runs row`);
                assert.match(recent.title, /A run counts here once it has finished/, `${w}: its tooltip says what the number counts: ${JSON.stringify(recent)}`);
            }
            await Page.navigate({ url: BASE + '/automations/recent' }); await Page.loadEventFired(); await install(); await coralReady(ev); // a fresh page on Recent runs; a phone has no hover: the sentence is a visible line on the page, not only the row's tooltip (#17706)
            await waitFor(`!!document.querySelector('.group-table-status')`, `${w}: the Recent runs line`, 6000);
            const line = await ev(`(() => { const p = document.querySelector('.group-table-status'), r = p.getBoundingClientRect(); return { text: p.textContent, shown: r.width > 0 && r.height > 0 && getComputedStyle(p).visibility !== 'hidden' }; })()`);
            assert.match(line.text, /not opened yet\. A run counts here once it has finished/, `${w}: the page says what the number counts: ${JSON.stringify(line)}`);
            assert.ok(line.shown, `${w}: the line is on screen: ${JSON.stringify(line)}`);
        }
        console.log('PASS a turned-off job with a run going says so, and Recent runs says what it counts');
    } finally { await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
