// A table column that no row has anything in is not drawn (#9846, the column-sizing design note, rule 2): its head and its cells are hidden, and it comes back the moment a row has a value. The name column and an
// actions column are never hidden, a column with an action in it is not empty, and a table with no rows hides nothing. The table is the real data_table.js, built in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const build = rows => ev(`(async () => {
        const DT = await import(${S} + 'data_table.js'); document.getElementById('zz-table')?.remove();
        const host = document.createElement('div'); host.id = 'zz-table'; host.style.cssText = 'position:fixed;inset:60px 20px auto 20px;z-index:9999;background:var(--bg-primary)'; document.body.append(host);
        const t = DT.dataTable({ label: 'Test list, ${'$'}{0}', rows: ${JSON.stringify(rows)}, rowKey: r => r.id, state: DT.tableState(),
            columns: [
                { key: 'name', label: 'Item', primary: true, width: 'grow', field: 'name', sort: true },
                { key: 'cli', label: 'CLI', width: '6rem', cell: r => r.cli || '' },
                { key: 'folder', label: 'Folder', width: '8rem', cell: r => r.folder || '\\u2014' },
                { key: 'goal', label: 'Goal', width: '10rem', cell: r => r.goal || '' },
                { key: 'keep', label: 'Keep', width: '6rem', hideWhenEmpty: false, cell: r => '' },
                { key: 'actions', label: 'Actions', width: '8rem', cell: r => { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Open'; return b; } },
            ] });
        host.append(t.el); return true; })()`);
    const view = () => ev(`(() => { const host = document.getElementById('zz-table'); const shown = e => !!e && getComputedStyle(e).display !== 'none'; const heads = [...host.querySelectorAll('thead th.dt-th')].map(th => ({ k: th.dataset.key, shown: shown(th) })); const cells = [...host.querySelectorAll('tbody tr.dt-row')].map(tr => [...tr.querySelectorAll('td.dt-td')].map(td => ({ k: td.dataset.key, shown: shown(td) }))); return { heads, cells }; })()`);
    const shownKeys = v => v.heads.filter(h => h.shown).map(h => h.k);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

        await build([{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }]);
        await waitFor(`!!document.querySelector('#zz-table tbody tr.dt-row')`, 'the rows', 6000);
        let v = await view();
        assert.deepEqual(shownKeys(v), ['name', 'keep', 'actions'], 'CLI, Folder (only a dash) and Goal are empty on every row: not drawn; the name, Keep (it opts out) and Actions stay: ' + JSON.stringify(v.heads));
        assert.ok(v.cells.every(r => r.filter(c => c.shown).map(c => c.k).join() === 'name,keep,actions'), 'the cells of those columns are hidden on every row too: ' + JSON.stringify(v.cells));

        await build([{ id: 'a', name: 'First' }, { id: 'b', name: 'Second', cli: 'Claude' }]);
        await waitFor(`!!document.querySelector('#zz-table tbody tr.dt-row')`, 'the rows again', 6000);
        v = await view();
        assert.deepEqual(shownKeys(v), ['name', 'cli', 'keep', 'actions'], 'one row has a CLI: the column is drawn, for every row: ' + JSON.stringify(v.heads));

        await build([]);
        await waitFor(`!!document.querySelector('#zz-table thead th.dt-th')`, 'the head with no rows', 6000);
        v = await view();
        assert.deepEqual(shownKeys(v), ['name', 'cli', 'folder', 'goal', 'keep', 'actions'], 'a table with no rows hides nothing: ' + JSON.stringify(v.heads));
        console.log('PASS table empty columns: an empty column is not drawn, it returns with a value; name, actions and an opted-out column stay; no rows hides nothing');
    } finally { await ev(`document.getElementById('zz-table')?.remove(); true`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
