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
        const controls = await ev(`(() => { const ref = document.createElement('select'); ref.className = 'list-bar-select'; document.body.append(ref); const rs = getComputedStyle(ref); const expected = [rs.borderTopColor, rs.borderRadius, rs.backgroundColor]; const result = [...document.querySelectorAll('#dt-host .dt-sortbar-select, #dt-host .dt-sortbar-dir')].map(c => { const s = getComputedStyle(c); return { height: c.getBoundingClientRect().height, style: [s.borderTopColor, s.borderRadius, s.backgroundColor], border: s.borderTopWidth }; }); ref.remove(); return { expected, result }; })()`);
        for (const control of controls.result) { assert.ok(control.height >= 44); assert.equal(control.border, '1px'); assert.deepEqual(control.style, controls.expected, 'phone sorting matches toolbar control styling'); }
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host').append(DT.progressCell(2, 5)); return true; })()`);
        await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] });
        assert.ok(await ev(`(() => { const s = getComputedStyle(document.querySelector('#dt-host .dt-progress-meter')); return matchMedia('(forced-colors: active)').matches && s.borderTopWidth === '1px' && s.borderTopStyle === 'solid' && s.borderTopColor !== s.backgroundColor; })()`), 'the progress track has a visible 1px edge in forced colors');
        await Emulation.setEmulatedMedia({ features: [] });
        await ev(`(() => { const s = document.querySelector('#dt-host .dt-sortbar-select'); s.value = 'n'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        assert.deepEqual(await names(), ['alpha', 'Delta', 'Bravo', 'Charlie'], 'the Sort by select sorts');
        // a name cut by its row (an ellipsis) can be read whole: every primary name carries its text as a title (#8206)
        const titles = await ev(`[...document.querySelectorAll('#dt-host tbody tr .dt-primary')].map(b => [b.textContent, b.title])`);
        assert.ok(titles.length > 0 && titles.every(([t, title]) => title === t), 'each primary name has its full text as a title: ' + JSON.stringify(titles));
        // a name too long for the phone's row ends in an ellipsis: the 44 px button is not a flex box (text-overflow does nothing on one, and the name was cut off mid-letter, #8149)
        const clip = await ev(`(() => { const td = document.querySelector('#dt-host tbody tr .dt-primary').parentElement; const b = td.querySelector('.dt-primary').cloneNode(true); b.textContent = 'a-name-too-long-for-a-phone-row-'.repeat(8); td.append(b); const s = getComputedStyle(b); const out = { display: s.display, to: s.textOverflow, over: b.scrollWidth > b.clientWidth, h: Math.round(b.getBoundingClientRect().height) }; b.remove(); return out; })()`);
        assert.ok(!/flex/.test(clip.display) && clip.to === 'ellipsis' && clip.over && clip.h >= 44, 'a long name is cut with an ellipsis and stays a 44 px target: ' + JSON.stringify(clip));
        await ev(`document.querySelector('#dt-host .dt-sortbar-dir').click(); true`);
        assert.deepEqual(await names(), ['Charlie', 'Bravo', 'Delta', 'alpha'], 'and its direction button reverses it');
        console.log('   ✓');

        console.log('4. Empty, footer');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove(); const host = document.createElement('div'); host.id = 'dt-host'; document.body.append(host);
            window.__log = []; host.append(DT.dataTable({ label: 'None', columns: [{ key: 'a', label: 'A', field: 'a' }], rows: [], rowKey: r => r.a, empty: { line: 'Nothing here', hint: 'Make one', action: { label: 'Make', run: () => window.__log.push('made') } } }).el);
            const h2 = document.createElement('div'); h2.id = 'dt-host2'; document.body.append(h2); h2.append(DT.dataTable({ label: 'Paged', columns: [{ key: 'a', label: 'A', field: 'a' }], rows: [{ a: 1 }], rowKey: r => r.a, footer: { text: 'Showing 1 of 5', more: { label: 'Load more', run: () => window.__log.push('more') } } }).el); return true; })()`);
        assert.equal(await ev(`document.querySelector('#dt-host .empty-state-line').textContent`), 'Nothing here');
        await ev(`document.querySelector('#dt-host .empty-state .btn').click(); document.querySelector('#dt-host2 .dt-more').click(); true`);
        assert.deepEqual(await ev(`window.__log`), ['made', 'more']); assert.equal(await ev(`document.querySelector('#dt-host2 .dt-foot-text').textContent`), 'Showing 1 of 5');
        // footer.auto (#7937): no footer when there is nothing more to load; with more to load, the same footer as before
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); const mk = (id, footer) => { const h = document.createElement('div'); h.id = id; document.body.append(h); h.append(DT.dataTable({ label: id, columns: [{ key: 'a', label: 'A', field: 'a' }], rows: [{ a: 1 }, { a: 2 }], rowKey: r => r.a, footer }).el); };
            mk('dt-auto-all', { auto: true, text: 'Showing 2 of 2' }); mk('dt-auto-more', { auto: true, text: 'Showing 2 of 5', more: { label: 'Load more', run: () => {} } }); mk('dt-plain-all', { text: 'Showing 2 of 2' }); return true; })()`);
        assert.equal(await ev(`document.querySelectorAll('#dt-auto-all .dt-foot').length`), 0, 'auto: all rows shown, no footer');
        assert.equal(await ev(`document.querySelector('#dt-auto-more .dt-foot-text').textContent + '|' + document.querySelector('#dt-auto-more .dt-more').textContent`), 'Showing 2 of 5|Load more', 'auto: more to load, the footer stays');
        assert.equal(await ev(`document.querySelector('#dt-plain-all .dt-foot-text').textContent`), 'Showing 2 of 2', 'without auto the footer is as it was');
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
        console.log('8. Column widths: drag, keys, fit, kept, reset, no handles when folded (#7949)');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const KEY = 'coral-dt-widths:Fixture';
        await ev(`localStorage.removeItem(${JSON.stringify(KEY)}); true`);
        await mount();
        const W = key => ev(`Math.round(document.querySelector('#dt-host th[data-key="${key}"]').getBoundingClientRect().width)`);
        const handle = key => ev(`(() => { const r = document.querySelector('#dt-host th[data-key="${key}"] .dt-resize').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
        const drag = async (key, dx) => { const h = await handle(key); await mouse('mouseMoved', h.x, h.y); await mouse('mousePressed', h.x, h.y); for (let i = 1; i <= 4; i++) await mouse('mouseMoved', h.x + Math.round(dx * i / 4), h.y); await mouse('mouseReleased', h.x + dx, h.y); };
        const heads = await ev(`[...document.querySelectorAll('#dt-host thead th')].map(t => { const h = t.querySelector('.dt-resize'); return h ? [h.getAttribute('role'), h.getAttribute('aria-label'), h.tabIndex, h.getAttribute('aria-orientation')] : null; })`);
        assert.deepEqual(heads.map(h => h && h[1]), ['Resize Name column', 'Resize Who column', 'Resize Count column', 'Resize Updated column', 'Resize Link column'], 'every header has a named handle');
        assert.ok(heads.every(h => h && h[0] === 'separator' && h[2] === 0 && h[3] === 'vertical'), 'a focusable vertical separator');
        const w0 = { name: await W('name'), who: await W('who'), n: await W('n') };
        // the divider shows on hover or focus only; a press that does not move changes nothing and offers no Reset (#7968)
        const mark = key => ev(`getComputedStyle(document.querySelector('#dt-host th[data-key="${key}"] .dt-resize'), '::after').opacity`);
        await mouse('mouseMoved', 5, 5);
        assert.equal(await mark('who'), '0', 'at rest the header edges are not marked');
        const th = await ev(`(() => { const r = document.querySelector('#dt-host th[data-key="who"]').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
        await mouse('mouseMoved', th.x, th.y);
        await waitFor(`getComputedStyle(document.querySelector('#dt-host th[data-key="who"] .dt-resize'), '::after').opacity === '1'`, 'the hovered header shows its divider (it fades in)'); assert.equal(await mark('n'), '0', 'and only its own');
        await ev(`document.querySelector('#dt-host th[data-key="n"] .dt-resize').focus(); true`);
        await mouse('mouseMoved', 5, 5);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
        await waitFor(`getComputedStyle(document.querySelector('#dt-host th[data-key="n"] .dt-resize'), '::after').opacity === '1'`, 'a handle the keyboard is on shows its divider');
        await ev(`document.activeElement.blur(); true`);
        const hb = await handle('who'); await mouse('mouseMoved', hb.x, hb.y); await mouse('mousePressed', hb.x, hb.y); await mouse('mouseReleased', hb.x, hb.y);
        assert.equal(await ev(`localStorage.getItem(${JSON.stringify(KEY)})`), null, 'a press with no move keeps nothing');
        assert.equal(await ev(`document.querySelector('#dt-host .dt-widthbar').hidden && !document.querySelector('#dt-host .dt-box').classList.contains('dt-sized')`), true, 'and offers no Reset column widths: nothing changed');
        assert.equal(await ev(`document.querySelector('#dt-host th[data-key="who"]').getAttribute('aria-sort')`), 'none', 'and does not sort');
        await drag('who', 70);
        const w1 = { name: await W('name'), who: await W('who'), n: await W('n') };
        assert.ok(Math.abs(w1.who - (w0.who + 70)) <= 3, 'dragging the Who edge 70 px right widens it by 70: ' + JSON.stringify({ w0, w1 }));
        assert.ok(w1.name < w0.name - 50 && Math.abs(w1.n - w0.n) <= 2, 'the title column gives the room, the others stay: ' + JSON.stringify({ w0, w1 }));
        assert.equal(await ev(`document.querySelector('#dt-host th[data-key="who"]').getAttribute('aria-sort')`), 'none', 'a drag does not sort');
        assert.equal(await ev(`document.querySelector('#dt-host th[data-key="who"] .dt-resize').getAttribute('aria-valuenow')`), String(w1.who), 'the separator says its width');
        await drag('who', -1000);
        assert.ok((await W('who')) >= 64 && (await W('who')) <= 70, 'a column never gets narrower than its minimum: ' + await W('who'));
        await drag('who', 120);
        const kept = await W('who');
        assert.deepEqual(Object.keys(JSON.parse(await ev(`localStorage.getItem(${JSON.stringify(KEY)})`))).includes('who'), true, 'the width is kept in this browser');
        await mount();
        assert.ok(Math.abs((await W('who')) - kept) <= 2, 'a redraw (a new table for the same list) has the kept width: ' + (await W('who')) + ' vs ' + kept);
        assert.equal(await ev(`!!document.querySelector('#dt-host .dt-reset-widths') && !document.querySelector('#dt-host .dt-widthbar').hidden`), true, 'Reset column widths is there while any width is set');
        // the keyboard
        await ev(`document.querySelector('#dt-host th[data-key="n"] .dt-resize').focus(); true`);
        const before = await W('n');
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
        assert.ok(Math.abs((await W('n')) - (before + 16)) <= 2, 'Right widens by 16 px: ' + before + ' to ' + await W('n'));
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
        assert.ok(Math.abs((await W('n')) - before) <= 2, 'Left narrows it again');
        assert.equal(await ev(`document.activeElement.classList.contains('dt-resize')`), true, 'the keyboard stays on the handle');
        // fit to content
        await drag('who', 200);
        const wide = await W('who');
        await ev(`document.querySelector('#dt-host th[data-key="who"] .dt-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
        const fit = await W('who');
        assert.ok(fit < wide - 40 && fit >= 64, 'a double click fits the column to what is in it: ' + wide + ' to ' + fit);
        // reset
        await ev(`document.querySelector('#dt-host .dt-reset-widths').click(); true`);
        assert.equal(await ev(`localStorage.getItem(${JSON.stringify(KEY)})`), null, 'Reset forgets the widths');
        assert.ok(Math.abs((await W('who')) - w0.who) <= 3 && !(await ev(`document.querySelector('#dt-host .dt-box').classList.contains('dt-sized')`)), 'and the columns are as they were');
        assert.equal(await ev(`document.querySelector('#dt-host .dt-widthbar').hidden`), true, 'the reset bar goes');
        // folded: no handles
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await mount(); await waitFor(`document.querySelector('#dt-host .dt-box').classList.contains('dt-folded')`, 'folded');
        assert.equal(await ev(`[...document.querySelectorAll('#dt-host .dt-resize')].filter(h => h.getClientRects().length).length`), 0, 'no handles in the folded layout');
        console.log('9. A row\'s detail, and the hooks a surface keeps on its rows (#7903)');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); window.__open = new Set(['b']); const host = document.getElementById('dt-host'); host.replaceChildren(DT.dataTable({ label: 'With detail', columns: [{ key: 'name', label: 'Name', primary: true, field: 'name', sort: true }], rows: [{ name: 'a' }, { name: 'b' }], rowKey: r => r.name,
            detail: { id: r => 'd-' + r.name, open: r => window.__open.has(r.name), render: r => { const p = document.createElement('p'); p.textContent = 'about ' + r.name; return p; } },
            decorate: (r, tr, d) => { tr.id = 'row-' + r.name; tr.classList.add('hooked'); if (d) d.classList.add('hooked-detail'); }, decorateHead: (th, c) => th.classList.add('head-' + c.key) }).el); return true; })()`);
        const det = () => ev(`({ rows: document.querySelectorAll('#dt-host tbody tr.dt-row').length, details: [...document.querySelectorAll('#dt-host tbody tr.dt-detail')].map(d => ({ id: d.id, hidden: d.hidden, shown: d.getClientRects().length > 0, text: d.textContent, span: d.firstElementChild.colSpan, after: d.previousElementSibling.id })),
            hooks: [...document.querySelectorAll('#dt-host tr.hooked')].map(t => t.id), hookedDetails: document.querySelectorAll('#dt-host tr.hooked-detail').length, head: !!document.querySelector('#dt-host th.head-name') })`);
        let dd = await det();
        assert.equal(dd.rows, 2); assert.deepEqual(dd.details.map(x => [x.id, x.hidden, x.shown, x.after]), [['d-a', true, false, 'row-a'], ['d-b', false, true, 'row-b']], 'a detail row follows its row, hidden until the surface says open: ' + JSON.stringify(dd));
        assert.equal(dd.details[1].text, 'about b'); assert.equal(dd.details[1].span, 1, 'one cell across the table');
        assert.deepEqual(dd.hooks, ['row-a', 'row-b']); assert.equal(dd.hookedDetails, 2); assert.equal(dd.head, true, 'decorate and decorateHead reach the rows and the header');
        await ev(`document.querySelector('#dt-host .dt-sort').click(); document.querySelector('#dt-host .dt-sort').click(); true`);
        dd = await det();
        assert.deepEqual(dd.hooks, ['row-b', 'row-a'], 'a sort draws the rows again and the hooks come with them (descending now): ' + JSON.stringify(dd));
        assert.equal(dd.hookedDetails, 2); assert.equal(dd.head, true, 'and the header\'s');
        assert.deepEqual(dd.details.map(x => [x.id, x.after]), [['d-b', 'row-b'], ['d-a', 'row-a']], 'each detail still follows its own row');
        console.log('   ✓');
        console.log('Tags never break mid-word (#8220)');
        const tg = await ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); const box = document.createElement('div'); box.id = 'tag-box'; box.style.cssText = 'width:96px;font-size:13px'; document.body.append(box);
            const mk = t => { const w = document.createElement('div'); const e = DT.tag(t); w.append(e); box.append(w); return e; };
            const one = mk('west'), hyph = mk('build-west'), two = mk('private network');
            const r = { one: one.getBoundingClientRect().height, hyph: hyph.getBoundingClientRect().height, two: two.getBoundingClientRect().height, ws: getComputedStyle(hyph).whiteSpace }; box.remove(); return r; })()`);
        assert.equal(tg.ws, 'nowrap', 'a tag does not wrap');
        assert.ok(Math.abs(tg.hyph - tg.one) <= 1 && Math.abs(tg.two - tg.one) <= 1, 'a hyphenated name and two words are one line, as one short word is, in a narrow cell: ' + JSON.stringify(tg));
        console.log('PASS data_table: desktop, sort, sticky head, the fold, empty and footer, selection');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
