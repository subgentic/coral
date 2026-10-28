// The Automations pages on a phone, from the Mobile Beta Tester's pass (#10476): a run a job started links back to its job and says "Run by job <name>" (not a way back to the workflow); reopening Automations lands on the list, not the last run page; the pages are
// drawn from the real modules with the server's answers stubbed in the page. At 390 px (a phone) and 1280 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const WF = { id: 7, name: 'nightly-build', description: '', enabled: true, steps: [{ name: 'Build', type: 'shell', command: 'make' }], max_duration_s: 300, created_at: '2026-10-27T10:00:00Z' };
const JOB = { id: 5, name: 'Every night', description: '', enabled: false, workflow_id: 7, cron_expr: '0 2 * * *', timezone: 'UTC', next_fire_at: '2026-10-29T02:00:00Z', created_at: '2026-10-27T10:00:00Z', last_run: null };
const RUN = { id: 31, workflow_id: 7, workflow_name: 'nightly-build', trigger_type: 'job', trigger_context: JSON.stringify({ scheduled_job_id: 5, scheduled_run_id: 9 }), status: 'completed', started_at: '2026-10-28T02:00:00Z', finished_at: '2026-10-28T02:00:03Z', steps: [{ name: 'Build', type: 'shell', status: 'completed', exit_code: 0, output_tail: 'ok' }, { name: 'Say hello', type: 'agent', status: 'completed', output_tail: JSON.stringify({ is_error: false, result: 'Hello from the agent. The build is green.', duration_ms: 4200 }) }] };
const STUB = `(() => {
    const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    const inner = window.fetch;
    window.fetch = (url, opts = {}) => {
        const u = String(url && url.url || url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0], m = (opts.method || 'GET').toUpperCase();
        if (m === 'GET' && u === '/api/workflows') return json({ workflows: [${JSON.stringify(WF)}] });
        if (m === 'GET' && u === '/api/workflows/7') return json(${JSON.stringify(WF)});
        if (m === 'GET' && u === '/api/workflows/7/runs') return json({ runs: [${JSON.stringify(RUN)}], total: 1 });
        if (m === 'GET' && u === '/api/workflows/runs/31') return json(${JSON.stringify(RUN)});
        if (m === 'GET' && u === '/api/scheduled/jobs') return json({ jobs: [${JSON.stringify(JOB)}] });
        if (m === 'GET' && /^\\/api\\/scheduled\\/jobs\\/5\\/runs/.test(u)) return json({ runs: [], total: 0 });
        return inner(url, opts);
    };
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.openAutomationsFolder('jobs'); true`);
            await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].some(c => c.textContent.includes('Every night'))`, `${tag}: the job row`, 10000);
            // (1) a run a job started: it says which job and the way back is that job
            await ev(`window.selectWorkflowRun(31); true`);
            await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title')`, `${tag}: the run page`, 10000);
            const run = await ev(`(() => ({ back: (document.getElementById('wf-run-back') || {}).textContent || '', meta: (document.querySelector('#wf-run-detail .wf-run-meta') || {}).textContent || '', phoneBack: [...document.querySelectorAll('#wf-run-detail .wf-phone-back')].map(b => b.textContent.trim()) }))()`);
            if (!/Every night/.test(run.back)) problems.push(`${tag}: the run's way back is its job, not the workflow (it says "${run.back.trim()}")`);
            if (!/Run by job Every night/.test(run.meta.replace(/\s+/g, ' '))) problems.push(`${tag}: the run says Run by job <name> (it says "${run.meta.replace(/\s+/g, ' ').trim().slice(0, 80)}")`);
            if (!/Jobs/.test(run.phoneBack.join(' '))) problems.push(`${tag}: the phone's way back says Jobs (${JSON.stringify(run.phoneBack)})`);
            // (3) a step's result is the agent's reply text, not the JSON the CLI wrote
            const steps = await ev(`[...document.querySelectorAll('#wf-run-detail .wf-run-step-output')].map(e => e.textContent)`);
            const peeks = await ev(`[...document.querySelectorAll('#wf-run-detail .wf-run-step-peek')].map(e => e.textContent)`);
            if (steps[1] !== 'Hello from the agent. The build is green.' || !/^Hello from the agent/.test(peeks[1] || '')) problems.push(`${tag}: a step's result shows the reply text, not raw JSON (${JSON.stringify([steps[1], peeks[1]])})`);
            if (steps[0] !== 'ok') problems.push(`${tag}: a shell step's output is as it is (${JSON.stringify(steps[0])})`);
            await ev(`document.getElementById('wf-run-back').click(); true`);
            await waitFor(`!!document.querySelector('#scheduler-view .sched-title, #scheduler-detail h2')`, `${tag}: the job's page opens from the run's way back`, 10000);
            // (4) the job's Turn on and the workflow's Run do not sit in the same spot (a tap meant for one started a run): Run now is where Run is, Turn on is not
            await ev(`window.selectScheduledJob(5).then(() => true)`);
            await waitFor(`!!document.querySelector('#scheduler-view .sched-actions [data-on-click="job-toggle"]')`, `${tag}: the job's page with its bar`, 10000);
            const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
            const turnOn = await rect('#scheduler-view .sched-actions [data-on-click="job-toggle"]'), runNow = await rect('#scheduler-view .sched-actions [data-on-click="job-run-now"]');
            await ev(`window.selectWorkflow(7).then(() => true)`);
            await waitFor(`!!document.querySelector('#wf-detail-container .wf-detail-actions [data-on-click="wf-trigger"]')`, `${tag}: the workflow's page with its bar`, 10000);
            const runBtn = await rect('#wf-detail-container .wf-detail-actions [data-on-click="wf-trigger"]');
            const overlap = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
            if (overlap(turnOn, runBtn)) problems.push(`${tag}: the workflow's Run sits where the job's Turn on does (${JSON.stringify([runBtn, turnOn])})`);
            if (!overlap(runNow, runBtn)) problems.push(`${tag}: the job's Run now sits where the workflow's Run does (${JSON.stringify([runNow, runBtn])})`);
            // (2) a run's page is open at its own address (a reopened app), the person goes to another tab and comes back, or taps the Automations tab again on a phone: the folder's list, not the last run's page (pinned: this held when it was measured, #10476)
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/automations/workflows/7/runs/31' }); await Page.loadEventFired(); await install(); // the run's own address, as a reopened app or a shared link has it
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title')`, `${tag}: the run page again`, 10000);
            if (!mobile) await ev(`window.switchNavTab('agents'); true`); // on a phone the Automations tab is tapped again from the run's page
            await ev(`window.switchNavTab('automations'); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'automations' && !!document.querySelector('#group-table-view tbody tr[data-key]')`, `${tag}: the folder's list on coming back`, 10000);
            const back = await ev(`(() => { const shown = e => !!e && e.getClientRects().length > 0; return { run: shown(document.querySelector('#wf-run-detail .wf-run-title')), list: shown(document.querySelector('#group-table-view tbody tr[data-key]')), item: document.getElementById('workflows-view').hasAttribute('data-phone-item') }; })()`);
            if (back.run || !back.list || back.item) problems.push(`${tag}: reopening Automations lands on the list, not the last run page (${JSON.stringify(back)})`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Automations pages on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS a job\'s run page links back to its job');
})().catch(e => { console.error(e); process.exit(1); });
