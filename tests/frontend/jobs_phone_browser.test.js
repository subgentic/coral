// Jobs on a phone (#6139; Automations, Goal #74): a phone does not show the sidebar, so the Jobs folder is the page's table with the folders' select over it, a tap on a job shows its detail with Edit, and Edit opens
// the editor; on a wide screen the folders stay in the sidebar. The scheduled-jobs routes are stubbed (the paths the dashboard's own suites stub).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { tap } = require('./helpers/phone_targets');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const JOB = { id: 5, name: 'Hourly job', cron_expr: '0 * * * *', enabled: true, agent_type: 'claude', prompt: 'p', repo_path: '/tmp', consecutive_failures: 0 };
const STUB = `(() => {
    const inner = window.fetch;
    const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (url, opts = {}) => {
        const path = String(url && url.url || url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0], m = (opts.method || 'GET').toUpperCase();
        if (m === 'GET' && path === '/api/scheduled/jobs') return json({ jobs: [${JSON.stringify(JOB)}] });
        if (m === 'GET' && path === '/api/scheduled/jobs/5') return json(${JSON.stringify(JOB)});
        if (m === 'GET' && /^\\/api\\/scheduled\\/jobs\\/5\\/runs/.test(path)) return json({ runs: [] });
        return inner(url, opts);
    };
})();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [name, w, h, phone] of [['phone', 390, 844, true], ['desktop', 1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: phone }); await Emulation.setTouchEmulationEnabled({ enabled: phone });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('automations'); true`);
            await waitFor(`!!document.querySelector('#group-table-view button.dt-primary')`, 'the jobs table', 10000);
            if (!phone) { assert.equal(await ev(`!!document.querySelector('.sidebar #automations-nav-list .view-list-item')`), true, 'desktop: the folders are in the sidebar'); console.log('ok desktop'); continue; }
            assert.equal(await ev(`!!document.querySelector('#group-table-view .view-list-select') && !document.querySelector('.sidebar #automations-nav-list')?.getClientRects().length`), true, 'phone: the folders are one select over the Jobs table, not a column');
            await waitFor(`!!document.querySelector('#group-table-view button.dt-primary') && document.querySelector('#group-table-view button.dt-primary').getClientRects().length > 0`, 'the job in the list', 10000);
            await tap(ev, '#group-table-view button.dt-primary');
            await waitFor(`/Hourly job/.test(document.getElementById('scheduler-detail').textContent) && !!document.querySelector('#scheduler-detail [data-on-click="job-edit"]')`, 'the job detail', 10000);
            const detail = await ev(`(() => { const d = document.getElementById('scheduler-detail').getBoundingClientRect(); return { top: Math.round(d.top), vh: innerHeight }; })()`);
            assert.ok(detail.top < detail.vh - 250, // the list above it holds the shared header and its group headers (#7443): enough of the job is on screen to read it
                 `phone: the picked job's detail is brought into view (${JSON.stringify(detail)})`);
            await tap(ev, '#scheduler-detail [data-on-click="job-edit"]');
            await waitFor(`[...document.querySelectorAll('.modal, dialog')].some(m => m.getClientRects().length > 0 && /cron|schedule/i.test(m.textContent))`, 'the job editor', 10000);
            console.log('ok phone');
        }
        console.log('PASS Jobs on a phone: the list, a job and its editor are reachable');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
