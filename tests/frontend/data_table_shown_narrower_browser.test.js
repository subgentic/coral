// #12368: a table whose box is not shown (a dock that is shut) kept the pixel widths of its last layout, so a dock opened at a narrower width (a phone after a desktop) showed a table as wide as it was before until
// the next frame: a task row 30 px past its box at 390 on a Mac (task_verification_browser, red 3 of 3). The widths now go when the box has no room, and come back with the first frame it is shown.
// A fixture table in a box 600 px wide, the box hidden, made 360 px, shown again; read in the same task as the show, before any frame.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove(); localStorage.removeItem('coral-dt-widths:Shown');
            const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = 'position:fixed;top:60px;left:20px;width:600px;bottom:20px;overflow:auto;background:var(--bg-primary);z-index:9999';
            document.body.append(host);
            const rows = [1, 2, 3].map(i => ({ id: i, name: 'A task called number ' + i, state: 'Queued', who: 'someone' }));
            const def = { name: { key: 'name', label: 'Task', primary: true, width: 'grow', sort: true, field: 'name', cell: r => DT.primaryButton(r.name, 'Open ' + r.name) } };
            for (const k of ['state', 'who']) def[k] = { key: k, label: k[0].toUpperCase() + k.slice(1), sort: true, field: k, width: 'content' };
            const t = DT.dataTable({ label: 'Shown', columns: ['state', 'name', 'who'].map(k => def[k]), rows, rowKey: r => 'r' + r.id, open: () => {}, rowName: r => r.name, state: DT.tableState(), fold: 'none' });
            host.append(t.bar, t.selectButton, t.el); return true; })()`);
        await ev(framesJs(4));
        const wide = await ev(`document.querySelector('#dt-host .dt-table').getBoundingClientRect().width`);
        assert.ok(wide > 450, 'the table was laid out at the wide box: ' + wide);
        await ev(`document.getElementById('dt-host').style.display = 'none'; true`); await ev(framesJs(4)); // hidden: the observer has run with no room
        const r = await ev(`(() => { const h = document.getElementById('dt-host'); h.style.width = '360px'; h.style.display = ''; const b = h.querySelector('.dt-box'), t = h.querySelector('.dt-table');
            return { box: b.clientWidth, table: Math.round(t.getBoundingClientRect().width), rows: [...h.querySelectorAll('tbody tr')].map(x => Math.round(x.getBoundingClientRect().right - b.getBoundingClientRect().left)) }; })()`);
        assert.ok(r.box > 0 && r.box <= 360, 'the box is shown: ' + JSON.stringify(r));
        assert.ok(r.table <= r.box + 1, 'shown narrower, the table is not as wide as it was before (it is read before any frame): ' + JSON.stringify(r));
        await ev(framesJs(4));
        const after = await ev(`(() => { const b = document.querySelector('#dt-host .dt-box'), t = b.querySelector('.dt-table'); return { box: b.clientWidth, table: Math.round(t.getBoundingClientRect().width) }; })()`);
        assert.ok(after.table <= after.box + 1, 'and after the frame it is laid out for the narrow box: ' + JSON.stringify(after));
    } finally { await client.close(); }
    console.log('data_table_shown_narrower_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
