// One chip height at every width: a status chip (the dot and the word) is --chip-height (1 rem, 16 px) at 1280 and at 390, in a table that folds on a phone too. A folded-row rule used to set it to the row's meta
// height, 20 px. The checks are on the shared table's own chip (DT.chip) and tag. Drives Chrome over CDP against the isolated dev server; a fixture table mounted in the dashboard's own page.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove();
                const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = 'position:fixed;inset:60px 10px 10px 10px;overflow:auto;background:var(--bg-primary);z-index:9999'; document.body.append(host);
                const rows = [{ id: 1, name: 'Fix the flaky test', state: 'Queued', who: 'Dev' }, { id: 2, name: 'Review the shared table', state: 'In progress', who: 'QA' }];
                const cols = [{ key: 'state', label: 'State', line: 1, cell: r => DT.chip(r.state, 'goal-state-active') }, { key: 'name', label: 'Name', primary: true, width: 'grow', sort: true, line: 1, cell: r => DT.primaryButton(r.name, 'Open ' + r.name) }, { key: 'who', label: 'Who', line: 2, cell: r => DT.tag(r.who) }];
                const t = DT.dataTable({ label: 'Chips', columns: cols, rows, rowKey: r => 'r' + r.id, open: () => {}, rowName: r => r.name, state: DT.tableState(), compact: true });
                host.append(t.bar, t.selectButton, t.el); return true; })()`);
            await waitFor(`document.querySelectorAll('#dt-host .dt-chip').length === 2 && document.querySelectorAll('#dt-host .dt-tag').length === 2`, label + ': the chips', 6000);
            const r = await ev(`(() => { const host = document.getElementById('dt-host'), box = host.querySelector('.dt-box'); const hs = sel => [...host.querySelectorAll(sel)].map(e => Math.round(e.getBoundingClientRect().height * 10) / 10); return { folded: box.classList.contains('dt-folded'), chip: hs('.dt-chip'), tag: hs('.dt-tag') }; })()`);
            check(`${label}: the status chips are one height, --chip-height (16 px)`, r.chip.length === 2 && r.chip.every(x => x === 16), JSON.stringify(r));
            check(`${label}: the tag is the same height`, r.tag.length === 2 && r.tag.every(x => x === 16), JSON.stringify(r.tag));
            if (mobile) check(`${label}: the table is folded (the case that was 20 px)`, r.folded === true, JSON.stringify(r.folded));
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} chip height checks passed`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
