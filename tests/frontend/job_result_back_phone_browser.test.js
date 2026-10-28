// A scheduled run's result chat on a phone links back to its job (#10578, Mobile pass 35): the phone's own back control said "Chats" where the desktop link said the job (#10378), so a tap went to the Chats list.
// 390 px, isolated dev server, the jobs and runs stubbed (first_automation's setup). Drives Chrome over CDP through agent_view_harness.js.

const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
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
                if (/^\\/api\\/sessions\\/history\\/[0-9a-f-]+$/.test(u)) return json({ messages: [], total: 0, has_more: false });
                return real(input, init);
            };
            return true; })()`;
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the two jobs', 10000);
        await ev(`document.querySelector('#group-table-view tbody tr .dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#scheduler-detail [data-on-click="job-run-session"]')`, 'the run row link', 8000);
        await ev(`document.querySelector('#scheduler-detail [data-on-click="job-run-session"]').click(); true`);
        await new Promise(r => setTimeout(r, 2500)); // sleep-ok: the click's handler awaits the chat
        const r = await ev(`(() => { const vis = e => !!e && e.getClientRects().length > 0; const backs = [...document.querySelectorAll('#history-session-view .back-link, #history-back')].filter(vis).map(b => b.textContent.trim().replace(/\\s+/g, ' ')); return { backs, mobile: (document.querySelector('.mobile-history-back') || {}).textContent, mobileAction: (document.querySelector('.mobile-history-back') || {}).dataset.onClick }; })()`);
        const problems = [];
        if (!r.backs.length || !r.backs.every(b => /weekday-summary/.test(b))) problems.push('every visible back control names the job (they say ' + JSON.stringify(r.backs) + ')');
        await ev(`[...document.querySelectorAll('#history-session-view .back-link')].find(b => b.getClientRects().length)?.click(); true`);
        await waitFor(`!!document.querySelector('#scheduler-detail .sched-header h2') && /weekday-summary/.test(document.querySelector('#scheduler-detail .sched-header h2').textContent) && document.getElementById('scheduler-detail').getClientRects().length > 0`, 'the back control opens the job', 6000).catch(() => problems.push('the visible back control opens the job'));
        assert.deepEqual(problems, [], 'the result chat on a phone:\n  ' + problems.join('\n  '));
        console.log('PASS the phone result chat links back to its job');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
