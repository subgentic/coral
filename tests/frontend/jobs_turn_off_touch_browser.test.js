// A finger on More > Turn off (#17521, walk 74 H2): a DOM click reached the menu item but a finger's tap fell through to the row under it. Real touch events at the item's centre.
// Jobs on a phone (#6139; Automations, Goal #74): a phone does not show the sidebar, so the Jobs folder is the page's table with the folders' select over it, a tap on a job shows its detail with Edit, and Edit opens
// the editor; on a wide screen the folders stay in the sidebar. The scheduled-jobs routes are stubbed (the paths the dashboard's own suites stub).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { tap } = require('./helpers/phone_targets');
const { touchTap } = require('./helpers/touch_tap');
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
        if (m === 'POST' && path === '/api/scheduled/jobs/5/toggle') { (window.__toggles = window.__toggles || []).push(path); return json({ ok: true }); }
        return inner(url, opts);
    };
})();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('automations'); true`);
        await waitFor(`!!document.querySelector('#group-table-view button.dt-primary') && document.querySelector('#group-table-view button.dt-primary').getClientRects().length > 0`, 'the job in the list', 10000);
        await tap(ev, '#group-table-view button.dt-primary');
        await waitFor(`!!document.querySelector('#scheduler-detail .sched-more-btn')`, 'the job detail', 10000);
        const centre = (sel, block = 'center') => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (${JSON.stringify(block)}) e.scrollIntoView({ block: ${JSON.stringify(block)} }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || {}).outerHTML?.slice(0, 140) }; })()`);
        await touchTap(client, await centre('#scheduler-detail .sched-more-btn', 'end')); // the footer's More at the bottom edge of the screen: the menu opens below it
        await waitFor(`!document.querySelector('#scheduler-detail .sched-more-menu').hidden`, 'the More menu open', 5000);
        const item = await centre('#scheduler-detail .sched-more-menu [data-on-click="job-toggle"]', '');
        console.log('item', JSON.stringify(item));
        assert.ok(/job-toggle/.test(item.hit || ''), `a finger on Turn off lands on Turn off, not what is under it (hit: ${item.hit})`);
        await touchTap(client, item);
        await waitFor(`(window.__toggles || []).length === 1`, 'the toggle request from a finger tap', 5000);
        console.log('PASS More > Turn off answers a finger tap');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
