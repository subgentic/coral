// Automations by keyboard and screen reader (#10496): Enter on a job row, on the run page's way back to its job, on a workflow row and on a run row lands the keyboard on the page's heading (it was on the body, or on a
// control that was gone); a run that goes from running to completed is said once in the page's status line. At 1280 px; the pages are drawn from the real modules with the server's answers stubbed in the page.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
// The Automations pages on a phone, from the Mobile Beta Tester's pass (#10476): a run a job started links back to its job and says "Run by job <name>" (not a way back to the workflow); reopening Automations lands on the list, not the last run page; the pages are
// drawn from the real modules with the server's answers stubbed in the page. At 390 px (a phone) and 1280 px. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

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
        if (m === 'GET' && u === '/api/workflows/runs/32') return json({ ...${JSON.stringify(RUN)}, id: 32, status: window.__st32 || 'running', finished_at: (window.__st32 || 'running') === 'running' ? null : '2026-10-28T02:00:03Z' });
        return inner(url, opts);
    };
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a key's page draws after its answers
    const enter = async () => { const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }; await client.Input.dispatchKeyEvent({ type: 'keyDown', ...base, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', ...base }); };
    const focused = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : a.tagName.toLowerCase() + ' "' + a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40) + '"'; })()`);
    const check = async (what, want) => { await sleep(500); const got = await focused(); if (!want.test(got)) problems.push(`${what}: the keyboard is on ${want} (it is on ${got})`); }; // sleep-ok: a key's page draws after its answers
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const focusOn = sel => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.getClientRects().length); if (e) e.focus(); return !!e; })()`);
        // a job's row: Enter opens the job and the keyboard is on its name
        await ev(`window.openAutomationsFolder('jobs'); true`);
        await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].some(c => c.textContent.includes('Every night'))`, 'the job row', 10000);
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].find(c => c.textContent.includes('Every night')).focus(); true`);
        await enter(); await check('Enter on a job row', /^h2 "Every night/);
        // the run page's way back to its job
        await ev(`window.selectWorkflowRun(31); true`); await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title')`, 'the run page', 10000);
        await check('opening a run page', /^h2 "nightly-build, run #31/);
        assert.ok(await focusOn('#wf-run-back'));
        await enter(); await check('Enter on the run page\'s way back to its job', /^h2 "Every night/);
        // a workflow's row, then its run's row
        await ev(`window.openAutomationsFolder('workflows'); true`);
        await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].some(c => c.textContent.includes('nightly-build'))`, 'the workflow row', 10000);
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].find(c => c.textContent.includes('nightly-build')).focus(); true`);
        await enter(); await check('Enter on a workflow row', /^h2 "nightly-build/);
        await waitFor(`!!document.querySelector('#wf-run-table tbody tr .dt-primary, #wf-run-table tbody tr button')`, 'the workflow page\'s runs', 10000);
        await ev(`document.querySelector('#wf-run-table tbody tr .dt-primary, #wf-run-table tbody tr button').focus(); true`);
        await enter(); await check('Enter on a run row', /^h2 "nightly-build, run #31/);
        // a run that ends is said once
        await ev(`window.__st32 = 'running'; window.__said = []; new MutationObserver(() => { const t = document.getElementById('wf-status').textContent; if (t) window.__said.push(t); }).observe(document.getElementById('wf-status'), { childList: true, characterData: true, subtree: true }); window.selectWorkflowRun(32); true`);
        await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title') && /running/.test(document.querySelector('#wf-run-detail .wf-run-meta').textContent)`, 'the running run', 10000);
        await ev(`window.__st32 = 'completed'; true`);
        await waitFor(`/completed/.test(document.querySelector('#wf-run-detail .wf-run-meta').textContent)`, 'the run ends', 12000);
        await sleep(4000); // sleep-ok: two more polls would show a repeat
        const said = await ev(`window.__said.slice()`);
        if (said.length !== 1 || !/run #32/.test(said[0]) || !/completed/.test(said[0])) problems.push(`a run that ends is said once, with its number and how it ended (said ${JSON.stringify(said)})`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Automations by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS Automations: the keyboard lands on the heading, a run that ends is said once');
})().catch(e => { console.error(e); process.exit(1); });
