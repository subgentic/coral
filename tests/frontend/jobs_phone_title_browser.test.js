// Jobs on a phone has no title row of its own (#7722, the #7720 audit's finding 11): the top bar's tab picker already says "Jobs", as it says Workflows, Chats and Inbox on theirs, so the page's "Jobs"
// heading is for assistive technology only (still in the page, not drawn) and the list's search starts right under the top bar. 390 px with touch, isolated dev server, the census world's jobs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.switchNavTab('jobs'); true`);
        await waitFor(`!!document.querySelector('#scheduled-jobs-list [data-on-click="job-select"], #mobile-jobs-list [data-on-click="job-select"]') && document.getElementById('scheduler-view').getClientRects().length > 0`, 'the Jobs list', 10000);
        const m = await ev(`(() => { const h = document.querySelector('#sched-view-header h2'), r = h.getBoundingClientRect(), hd = document.getElementById('sched-view-header').getBoundingClientRect(), s = document.querySelector('#mobile-jobs-list .sidebar-search, #mobile-jobs-list input[type=search], #mobile-jobs-list input');
            const top = document.getElementById('scheduler-view').getBoundingClientRect().top; return { h2: [Math.round(r.width), Math.round(r.height)], header: Math.round(hd.height), text: h.textContent.trim(), searchGap: s ? Math.round(s.getBoundingClientRect().top - top) : null }; })()`);
        assert.equal(m.text, 'Jobs', 'the heading is still in the page ' + JSON.stringify(m));
        assert.ok(m.h2[0] <= 2 && m.h2[1] <= 2, 'but it is not drawn (1 px, clipped) ' + JSON.stringify(m));
        assert.ok(m.header <= 2 && m.searchGap !== null && m.searchGap <= 28, 'and the list starts right under the top bar (the sidebar header is 12 px of padding twice, as on the other tabs) ' + JSON.stringify(m));
        console.log('PASS Jobs on a phone has no title row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
