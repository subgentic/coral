// A workflow run's page: its Re-run bar follows the steps (#7722, the #7720 audit's finding 9). On a page shorter than the screen the bar used to be pinned to the foot with a wide empty gap above it;
// now it sits under the last step, a normal gap away, and a long page still keeps it in view (sticky). 1280 x 900, isolated dev server, the census world's workflow and failed run.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.openAutomationsFolder('workflows'); true`);
        await waitFor(`typeof window.selectWorkflowRun === 'function' && document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary').length > 0`, 'the workflows tab', 10000);
        await ev(`window.selectWorkflowRun(31); true`);
        await waitFor(`!!document.querySelector('#wf-run-detail-container .wf-run-actions') && document.querySelectorAll('#wf-run-detail-container .wf-run-step').length === 3`, 'the run page with its bar', 10000);
        const g = await ev(`(() => { const c = document.getElementById('wf-run-detail-container'), bar = c.querySelector('.wf-run-actions'), steps = [...c.querySelectorAll('.wf-run-step')], last = steps[steps.length - 1];
            return { gap: Math.round(bar.getBoundingClientRect().top - last.getBoundingClientRect().bottom), barBottom: Math.round(bar.getBoundingClientRect().bottom), inner: innerHeight, sticky: getComputedStyle(bar).position }; })()`);
        assert.ok(g.gap >= 0 && g.gap <= 64, `the Re-run bar is under the last step, not pinned far below it (gap ${g.gap}px) ${JSON.stringify(g)}`);
        assert.equal(g.sticky, 'sticky', 'and it is still a sticky bar, kept in view on a long page ' + JSON.stringify(g));
        console.log('PASS the run page bar follows its steps');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
