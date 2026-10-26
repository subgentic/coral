// The one table (#7743, data_table.js): desktop, the fold at 390 px (and at a width of 40 rem), sort both ways and from the folded Sort by select, a row click against an inner link, the empty state, the footer row, the sticky header, and
// selection (checkboxes, shift range, header tri-state, the bar and its confirm, the context change, the phone's Select mode). A fixture table mounted in the dashboard's own page. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const mount = (extra = '') => ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove();
        const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = 'position:fixed;inset:60px 20px 20px 20px;overflow:auto;background:var(--bg-primary);z-index:9999'; document.body.append(host);
        const rows = [{ id: 1, name: 'Charlie', n: 30, at: '2026-10-20T10:00:00Z', who: 'Dev' }, { id: 2, name: 'alpha', n: 5, at: '2026-10-22T10:00:00Z', who: 'QA' }, { id: 3, name: 'Bravo', n: 12, at: '2026-10-21T10:00:00Z', who: 'Dev' }, { id: 4, name: 'Delta', n: 7, at: '2026-10-19T10:00:00Z', who: '' }];
        window.__log = []; window.__st = DT.tableState();
        const cols = [{ key: 'name', label: 'Name', primary: true, width: 'grow', sort: true, line: 1, field: 'name', cell: r => DT.primaryButton(r.name, 'Open ' + r.name) }, { key: 'who', label: 'Who', sort: true, line: 2, field: 'who', cell: r => DT.avatar(r.who) },
            { key: 'n', label: 'Count', numeric: true, tone: 'tertiary', sort: 'number', line: 2, field: 'n' }, { key: 'at', label: 'Updated', tone: 'tertiary', align: 'end', sort: 'date', sortValue: r => r.at, line: 1, cell: r => DT.timeCell(r.at) },
            { key: 'link', label: 'Link', line: 0, cell: r => DT.link('go ' + r.id, () => window.__log.push('link ' + r.id)) }];
        const t = DT.dataTable({ label: 'Fixture', columns: cols, rows, rowKey: r => 'r' + r.id, open: r => window.__log.push('open ' + r.id), rowName: r => r.name, state: window.__st, ${extra} });
        window.__t = t; host.append(t.bar, t.selectButton, t.el); return true; })()`);
    const names = () => ev(`[...document.querySelectorAll('#dt-host tbody tr .dt-primary')].map(b => b.textContent)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

        console.log('1. Desktop: the head, the levels, sort both ways, row click and inner link');
        await mount();
        const d = await ev(`(() => { const h = document.querySelector('#dt-host thead th'), hs = getComputedStyle(h), p = document.querySelector('#dt-host .dt-primary'), ps = getComputedStyle(p), tr = document.querySelector('#dt-host tbody tr').getBoundingClientRect();
            return { heads: [...document.querySelectorAll('#dt-host thead th')].map(t => t.textContent.replace(/[↑↓↕]/g, '').trim()), head: hs.fontSize + ' ' + hs.fontWeight + ' ' + hs.textTransform, primary: ps.fontSize + ' ' + ps.fontWeight, h: Math.round(tr.height), folded: !!document.querySelector('#dt-host .dt-box').classList.contains('dt-folded'), roles: [document.querySelector('#dt-host table').getAttribute('role'), document.querySelector('#dt-host tbody tr').getAttribute('role'), document.querySelector('#dt-host td').getAttribute('role')] }; })()`);
        assert.deepEqual(d.heads, ['Name', 'Who', 'Count', 'Updated', 'Link'], 'the heads'); assert.equal(d.head, '11px 600 uppercase', 'the head is 11/600 uppercase'); assert.equal(d.primary, '14px 600', 'the primary is 14/600'); assert.ok(d.h <= 38, 'a row is about 36 px ' + d.h); assert.equal(d.folded, false, 'not folded at 1280');
        assert.deepEqual(d.roles, ['table', 'row', 'cell'], 'the roles are explicit');
        await ev(`document.querySelector('#dt-host .dt-sort[data-key="name"]').click(); true`);
        assert.deepEqual(await names(), ['alpha', 'Bravo', 'Charlie', 'Delta'], 'text sort, case-insensitive, ascending');
        assert.equal(await ev(`document.querySelector('#dt-host th[data-key="name"]').getAttribute('aria-sort')`), 'ascending');
        await ev(`document.querySelector('#dt-host .dt-sort[data-key="name"]').click(); true`);
        assert.deepEqual(await names(), ['Delta', 'Charlie', 'Bravo', 'alpha'], 'and descending'); assert.equal(await ev(`document.querySelector('#dt-host th[data-key="name"]').getAttribute('aria-sort')`), 'descending');
        await ev(`document.querySelector('#dt-host .dt-sort[data-key="n"]').click(); true`);
        assert.deepEqual(await names(), ['alpha', 'Delta', 'Bravo', 'Charlie'], 'numbers sort as numbers (5, 7, 12, 30), not as text');
        await ev(`document.querySelector('#dt-host .dt-sort[data-key="at"]').click(); true`);
        assert.deepEqual(await names(), ['Delta', 'Charlie', 'Bravo', 'alpha'], 'dates sort by their value');
        assert.equal(await ev(`document.activeElement === document.querySelector('#dt-host .dt-sort[data-key="at"]')`), false, 'a click on a sort button keeps focus where the pointer left it (not asserted further)');
        await ev(`window.__log.length = 0; document.querySelector('#dt-host .dt-link').click(); true`);
        assert.deepEqual(await ev(`window.__log`), ['link ' + await ev(`document.querySelector('#dt-host tbody tr').dataset.key.slice(1)`)], 'an inner link wins on its own click (the row does not open)');
        await ev(`window.__log.length = 0; document.querySelector('#dt-host tbody tr td:nth-child(2)').click(); true`);
        assert.match((await ev(`window.__log`))[0], /^open /, 'a click elsewhere on the row opens it');
        console.log('   ✓');

        console.log('2. Sticky header in a scrolled table');
        await mount();
        await ev(`(() => { const h = document.getElementById('dt-host'); const t = h.querySelector('tbody'); for (let i = 0; i < 40; i++) t.append(t.firstElementChild.cloneNode(true)); h.scrollTop = 300; return true; })()`);
        const sticky = await ev(`(() => { const h = document.getElementById('dt-host'), th = h.querySelector('thead th'); return { top: Math.round(th.getBoundingClientRect().top - h.getBoundingClientRect().top), scrolled: h.scrollTop }; })()`);
        assert.ok(sticky.scrolled > 100 && sticky.top <= 1, 'the header stays at the top of the scrolled area ' + JSON.stringify(sticky));
        console.log('   ✓');

        console.log('3. Folded at 390 px: the two-line row, the Sort by select');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await mount();
        await waitFor(`!!document.querySelector('#dt-host .dt-box').classList.contains('dt-folded')`, 'the table folds');
        const f = await ev(`(() => { const box = document.querySelector('#dt-host .dt-box'); const rows = [...box.querySelectorAll('tbody tr')]; const r = rows[0];
            return { thead: getComputedStyle(box.querySelector('thead')).display, sortbar: getComputedStyle(box.querySelector('.dt-sortbar')).display, h: rows.map(x => Math.round(x.getBoundingClientRect().height)), hidden: getComputedStyle(r.querySelector('td[data-key="link"]')).display,
                line1: [...r.querySelectorAll('td.dt-line-1')].map(td => td.dataset.key), line2Top: Math.round(r.querySelector('td.dt-line-2').getBoundingClientRect().top - r.querySelector('td.dt-line-1').getBoundingClientRect().top), over: document.documentElement.scrollWidth - innerWidth }; })()`);
        assert.equal(f.thead, 'none', 'no header row'); assert.equal(f.sortbar, 'flex', 'the Sort by select'); assert.ok(f.h.every(h => h >= 44), 'rows are 44 px or more ' + JSON.stringify(f.h)); assert.equal(f.hidden, 'none', 'a line 0 column is not drawn'); assert.ok(f.line2Top >= 14, 'line 2 is under line 1 ' + JSON.stringify(f)); assert.ok(f.over <= 1, 'no sideways scroll');
        await ev(`(() => { const s = document.querySelector('#dt-host .dt-sortbar-select'); s.value = 'n'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        assert.deepEqual(await names(), ['alpha', 'Delta', 'Bravo', 'Charlie'], 'the Sort by select sorts');
        await ev(`document.querySelector('#dt-host .dt-sortbar-dir').click(); true`);
        assert.deepEqual(await names(), ['Charlie', 'Bravo', 'Delta', 'alpha'], 'and its direction button reverses it');
        console.log('   ✓');

        console.log('4. Empty, footer');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove(); const host = document.createElement('div'); host.id = 'dt-host'; document.body.append(host);
            window.__log = []; host.append(DT.dataTable({ label: 'None', columns: [{ key: 'a', label: 'A', field: 'a' }], rows: [], rowKey: r => r.a, empty: { line: 'Nothing here', hint: 'Make one', action: { label: 'Make', run: () => window.__log.push('made') } } }).el);
            const h2 = document.createElement('div'); h2.id = 'dt-host2'; document.body.append(h2); h2.append(DT.dataTable({ label: 'Paged', columns: [{ key: 'a', label: 'A', field: 'a' }], rows: [{ a: 1 }], rowKey: r => r.a, footer: { text: 'Showing 1 of 5', more: { label: 'Load more', run: () => window.__log.push('more') } } }).el); return true; })()`);
        assert.equal(await ev(`document.querySelector('#dt-host .dt-empty-line').textContent`), 'Nothing here');
        await ev(`document.querySelector('#dt-host .dt-empty .btn').click(); document.querySelector('#dt-host2 .dt-more').click(); true`);
        assert.deepEqual(await ev(`window.__log`), ['made', 'more']); assert.equal(await ev(`document.querySelector('#dt-host2 .dt-foot-text').textContent`), 'Showing 1 of 5');
        console.log('   ✓');

        console.log('5. Selection');
        const sel = `selectable: { contextKey: 'a', onChange: k => window.__log.push('sel ' + [...k].sort().join(',')), actions: [{ label: 'Mark', run: (rows, keys) => window.__log.push('mark ' + rows.map(r => r.id).sort().join(',')) }, { label: 'Remove', danger: true, confirm: n => 'Remove ' + n + ' items?', run: rows => window.__log.push('remove ' + rows.length) }] }`;
        await ev(`document.getElementById('dt-host2')?.remove(); true`);
        await mount(sel);
        const cb = (i) => `document.querySelectorAll('#dt-host tbody .dt-check input')[${i}]`;
        assert.equal(await ev(`document.querySelector('#dt-host .dt-bar').hidden`), true, 'no bar until something is selected');
        await ev(`${cb(0)}.click(); true`);
        assert.equal(await ev(`document.querySelector('#dt-host .dt-bar-count').textContent`), '1 selected');
        assert.equal(await ev(`document.querySelector('#dt-host .dt-check-all').indeterminate`), true, 'the header checkbox is indeterminate when some');
        await ev(`window.__log.length = 0; document.querySelectorAll('#dt-host tbody .dt-check input')[3].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true })); true`);
        assert.equal(await ev(`document.querySelector('#dt-host .dt-bar-count').textContent`), '4 selected', 'shift-click selects the range between');
        assert.equal(await ev(`document.querySelector('#dt-host .dt-check-all').checked`), true, 'all selected: the header is checked');
        await ev(`document.querySelector('#dt-host .dt-check-all').click(); true`);
        assert.equal(await ev(`document.querySelector('#dt-host .dt-bar').hidden`), true, 'the header checkbox clears all');
        await ev(`${cb(1)}.click(); ${cb(2)}.click(); window.__log.length = 0; [...document.querySelectorAll('#dt-host .dt-bar-action')].find(b => b.textContent === 'Mark').click(); true`);
        assert.deepEqual(await ev(`window.__log`), ['mark 2,3'], 'a bulk action gets the selected rows');
        await ev(`[...document.querySelectorAll('#dt-host .dt-bar-action')].find(b => b.textContent === 'Remove').click(); true`);
        assert.equal(await ev(`document.querySelector('#dt-host .dt-bar-confirm').textContent`), 'Remove 2 items?', 'a danger action confirms in the bar');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#dt-host .dt-bar button')].map(b => b.textContent)`), ['Keep', 'Remove', 'Clear'], 'Keep, the action, Clear');
        await ev(`document.querySelector('#dt-host .dt-bar-keep').click(); true`);
        assert.equal(await ev(`!!document.querySelector('#dt-host .dt-bar-confirm')`), false, 'Keep puts it away');
        await ev(`window.__log.length = 0; [...document.querySelectorAll('#dt-host .dt-bar-action')].find(b => b.textContent === 'Remove').click(); [...document.querySelectorAll('#dt-host .dt-bar button')].find(b => b.textContent === 'Remove').click(); true`);
        assert.deepEqual(await ev(`window.__log`), ['remove 2'], 'confirmed, it runs');
        // kept across a redraw, cleared when the context changes
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); const old = document.querySelector('#dt-host .dt-box'); const again = DT.dataTable({ label: 'Fixture', columns: [{ key: 'name', label: 'Name', primary: true, field: 'name' }], rows: [{ id: 2, name: 'alpha' }, { id: 3, name: 'Bravo' }], rowKey: r => 'r' + r.id, rowName: r => r.name, state: window.__st, selectable: { contextKey: 'a', actions: [] } }); old.replaceWith(again.el); return true; })()`);
        assert.equal(await ev(`document.querySelectorAll('#dt-host tbody tr.dt-selected').length`), 2, 'the selection is kept across a redraw');
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); const old = document.querySelector('#dt-host .dt-box'); const again = DT.dataTable({ label: 'Fixture', columns: [{ key: 'name', label: 'Name', primary: true, field: 'name' }], rows: [{ id: 2, name: 'alpha' }], rowKey: r => 'r' + r.id, rowName: r => r.name, state: window.__st, selectable: { contextKey: 'b', actions: [] } }); old.replaceWith(again.el); return true; })()`);
        assert.equal(await ev(`document.querySelectorAll('#dt-host tbody tr.dt-selected').length`), 0, 'cleared when the context changes');
        console.log('   ✓');

        console.log('6. Phone: Select mode');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await mount(sel);
        await waitFor(`!!document.querySelector('#dt-host .dt-box').classList.contains('dt-folded')`, 'folded');
        assert.equal(await ev(`getComputedStyle(document.querySelector('#dt-host tbody .dt-check')).display`), 'none', 'no checkboxes until Select');
        await ev(`document.querySelector('#dt-host .dt-select-toggle').click(); true`);
        const ph = await ev(`(() => { const c = document.querySelector('#dt-host tbody .dt-check'), i = c.querySelector('input').getBoundingClientRect(), cell = c.getBoundingClientRect(); return { display: getComputedStyle(c).display, w: Math.round(cell.width), box: Math.round(i.width), label: document.querySelector('#dt-host .dt-select-toggle').textContent }; })()`);
        assert.ok(ph.display === 'block' && ph.w >= 44 && ph.box >= 24 && ph.label === 'Done', 'Select shows 44 px checkboxes, the button says Done ' + JSON.stringify(ph));
        await ev(`window.__log.length = 0; document.querySelector('#dt-host tbody tr td[data-key="who"]').click(); true`);
        assert.equal(await ev(`document.querySelectorAll('#dt-host tbody tr.dt-selected').length`), 1, 'in Select mode a tap on the row selects it');
        assert.equal((await ev(`window.__log`)).some(x => /^open/.test(x)), false, 'and does not open it');
        console.log('   ✓');
        console.log('PASS data_table: desktop, sort, sticky head, the fold, empty and footer, selection');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
