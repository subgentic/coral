// A list's column headers are named for the column, not the table (Beta #10372 finding 6, #10374): the Inbox's headers read "Agent, Needs you, 1", "CLI, Needs you, 1" and so on, the list's name and count said again on every
// header. A table that is the page's one list (its name ends in a count: "Needs you, 1") names each sort button for its column alone; a table on a page of several that share column names (Analytics' "Cost", "Tokens") keeps the
// table in the name so no two read the same. The header's aria-sort says the sorted column, ascending or descending, and none for the rest. Read from the accessibility tree. 1280 px. Drives Chrome over CDP through
// agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axNodes } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const MOD = `(window.__coralStatic || '/static/')`;
    const prop = (n, name) => { const p = (n.properties || []).find(x => x.name === name); return p ? p.value.value : undefined; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove();
            const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = 'position:fixed;inset:60px 20px 20px 20px;overflow:auto;background:var(--bg-primary);z-index:9999'; document.body.append(host);
            const rows = [{ id: 1, name: 'alpha', who: 'Dev' }, { id: 2, name: 'bravo', who: 'QA' }];
            const cols = [{ key: 'name', label: 'Agent', primary: true, width: 'grow', sort: true, sortValue: r => r.name, cell: r => DT.primaryButton(r.name) }, { key: 'who', label: 'CLI', sort: true, sortValue: r => r.who, cell: r => r.who }];
            for (const [label, st0] of [['Needs you, 1', { key: 'name', dir: 'desc' }], ['Cost', null]]) {
                const st = DT.tableState(); if (st0) st.sort = st0;
                const t = DT.dataTable({ label, columns: cols, rows, rowKey: r => 'r' + r.id, rowName: r => r.name, state: st });
                const sec = document.createElement('section'); sec.dataset.t = label.split(',')[0]; sec.append(t.bar, t.el); host.append(sec);
            }
            return true; })()`);
        await client.Accessibility.enable();
        const t = await axNodes(client.Accessibility);
        const heads = t.filter(n => n.role && n.role.value === 'columnheader').map(n => ({ name: n.name && n.name.value, sort: prop(n, 'sort') }));
        const buttons = t.filter(n => n.role && n.role.value === 'button' && /^(Agent|CLI)/.test((n.name && n.name.value) || '')).map(n => n.name.value);
        check(buttons.includes('Agent') && buttons.includes('CLI'), `the counted table's sort buttons are named for the column alone: ${JSON.stringify(buttons)}`);
        check(!buttons.some(b => /Needs you/.test(b)), `no header says the list's name and count: ${JSON.stringify(buttons)}`);
        check(buttons.includes('Agent, Cost') && buttons.includes('CLI, Cost'), `a table that is one of several keeps its name in its buttons: ${JSON.stringify(buttons)}`);
        const sorted = await ev(`(() => [...document.querySelectorAll('#dt-host section[data-t="Needs you"] th')].map(th => th.getAttribute('aria-sort')))()`);
        check(JSON.stringify(sorted) === JSON.stringify(['descending', 'none']), `aria-sort says the sorted column and the rest none: ${JSON.stringify(sorted)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the table headers in the accessibility tree:\n  ' + problems.join('\n  '));
    console.log('PASS a list\'s headers are named for the column');
})().catch(e => { console.error(e); process.exit(1); });
