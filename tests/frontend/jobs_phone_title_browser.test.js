// The Jobs folder of Automations on a phone has no title row of its own (#7722, the #7720 audit's finding 11; Goal #74): the top bar's tab picker already says "Automations" and the folders' select (the Inbox's)
// names the folder, so the page draws no heading and the toolbar starts right under the select. 390 px with touch, isolated dev server, the census world's jobs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('automations'); true`);
        await waitFor(`!!document.querySelector('#group-table-view button.dt-primary') && document.getElementById('group-table-view').getClientRects().length > 0`, 'the Jobs folder', 10000);
        const m = await ev(`(() => { const head = document.querySelector('#group-table-view .inbox-folder-head'), sel = document.querySelector('#group-table-view .view-list-select'), top = document.getElementById('group-table-view').getBoundingClientRect().top, bar = document.querySelector('#group-table-view .list-bar-search-row');
            return { headDrawn: !!head && (head.getBoundingClientRect().width > 2 || head.getBoundingClientRect().height > 2), select: !!sel && sel.getClientRects().length > 0, selectName: sel ? sel.selectedOptions[0].textContent.replace(/\\s+/g, ' ').trim() : '', barGap: bar ? Math.round(bar.getBoundingClientRect().top - top) : null }; })()`);
        assert.equal(m.headDrawn, false, 'the folder page draws no title of its own on a phone: the folders\' select names it ' + JSON.stringify(m));
        assert.equal(m.select, true, 'the folders are one select over the table ' + JSON.stringify(m));
        assert.match(m.selectName, /^Jobs/, 'and it says which folder is on screen ' + JSON.stringify(m));
        assert.ok(m.barGap !== null && m.barGap <= 80, 'and the toolbar starts right under the select ' + JSON.stringify(m));
        console.log('PASS the Jobs folder on a phone has no title row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
