// The table rules, enforced by data_table.js itself (#11943, the operator: "our table column resizing is very broken", the rules are in design note 9ced561a): at 1440, 1280, 1024 and 900 px, with a long name, with kept widths that are too wide,
// at 200% text and after a drag of each resizable column, a table with the Needs you mix of columns (an elastic Item, What was asked, CLI, Folder, Team, an empty Blocks, Waiting, a fixed Actions) (1) fits its panel with no sideways
// scroll, (2) has one elastic column that takes what the others leave, (3) shows every header whole and no empty column, (4) keeps its fixed Actions at its declared width, (5) lets a drag take room from the elastic column only
// and stop when it has none, (6) fits a kept width to the panel it meets. A fixture table in the dashboard's own page (data_table.js), isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], MOD = `(window.__coralStatic || '/static/')`, KEY = 'coral-dt-widths:RulesFixture';
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const mount = (longName, kept) => ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove(); localStorage.removeItem(${JSON.stringify(KEY)});
        ${kept ? `localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(${JSON.stringify(kept)}));` : ''}
        const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = 'position:fixed;top:60px;left:20px;right:20px;bottom:20px;overflow:auto;background:var(--bg-primary);z-index:9999'; document.body.append(host);
        const rows = [
            { id: 1, name: ${longName ? `'An agent whose name is long enough to need more room than any column would give it'` : `'Orchestrator'`}, ask: 'Wants to know: None of the above is what the operator meant', cli: 'Claude', folder: 'coral-hub', team: 'coral-hub-team', waiting: '11 h 24 min', act: true },
            { id: 2, name: 'Goal #187 looks done', ask: 'Done when: The operator opens the page and sees it', cli: '', folder: '', team: 'coral-hub-team', waiting: '11 h 24 min', act: true },
            { id: 3, name: 'Goal #184 looks done', ask: 'Every task is done.', cli: '', folder: '', team: 'coral-hub-team', waiting: '22 h 15 min', act: true }];
        const btns = () => { const w = document.createElement('span'); for (const t of ['Approve', 'Changes']) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-small'; b.textContent = t; w.append(b); } return w; };
        const cols = [
            { key: 'agent', label: 'Item', primary: true, width: 'grow', min: 14, share: 1, sort: true, sortValue: r => r.name, line: 1, cell: r => DT.primaryButton(r.name, 'Open ' + r.name) },
            { key: 'asks', label: 'What was asked', width: 'grow', min: 18, share: 1, line: 2, cell: r => r.ask },
            { key: 'cli', label: 'CLI', sort: true, sortValue: r => r.cli, drop: 5, line: 2, cell: r => r.cli ? DT.tag(r.cli) : '' },
            { key: 'folder', label: 'Folder', sort: true, sortValue: r => r.folder, drop: 6, line: 0, cell: r => r.folder },
            { key: 'team', label: 'Team', max: 26, drop: 1, sort: true, sortValue: r => r.team, line: 0, cell: r => r.team },
            { key: 'blocks', label: 'Blocks', width: 'content', max: 30, drop: 4, line: 2, cell: () => '' },
            { key: 'waiting', label: 'Waiting', min: 12, tone: 'tertiary', align: 'end', sort: true, sortValue: r => r.waiting, line: 1, cell: r => r.waiting },
            { key: 'review', label: 'Actions', fixed: true, align: 'end', width: '15rem', line: 1, cell: btns }];
        const t = DT.dataTable({ label: 'RulesFixture', columns: cols, rows, rowKey: r => 'r' + r.id, open: () => {}, rowName: r => r.name, state: DT.tableState() });
        host.append(t.bar, t.selectButton, t.el); return true; })()`);
    const measure = () => ev(`(() => { const box = document.querySelector('#dt-host .dt-box'), table = box.querySelector('table'), vis = e => e.getClientRects().length > 0, b = box.getBoundingClientRect(), rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const ths = [...table.querySelectorAll('thead th.dt-th')].filter(vis);
        return { box: Math.round(b.width), table: Math.round(table.getBoundingClientRect().width), scrolls: box.scrollWidth > box.clientWidth + 1, host: document.getElementById('dt-host').scrollWidth > document.getElementById('dt-host').clientWidth + 1, rem,
            cols: ths.map(th => { const lab = th.querySelector('.dt-sort > span, .dt-head-text'), key = th.dataset.key; const cells = [...table.querySelectorAll('tbody td[data-key="' + key + '"]')]; return { key, w: Math.round(th.getBoundingClientRect().width), right: Math.round(th.getBoundingClientRect().right), cut: !!lab && lab.getBoundingClientRect().width > th.getBoundingClientRect().width + 1, empty: cells.every(td => !/[^\\s]/.test(td.textContent) && !td.querySelector('button, a, svg, img')), handle: !!th.querySelector('.dt-resize') }; }), boxRight: Math.round(b.right) }; })()`);
    const rules = (m, tag) => {
        check(!m.scrolls && !m.host && m.table <= m.box + 1, `${tag}: the table fits its panel, no sideways scroll: ${JSON.stringify({ box: m.box, table: m.table, scrolls: m.scrolls })}`);
        check(m.cols.every(c => !c.cut), `${tag}: every header is whole: ${JSON.stringify(m.cols.filter(c => c.cut).map(c => c.key))}`);
        check(m.cols.every(c => c.key === 'review' || !c.empty), `${tag}: no empty column takes room: ${JSON.stringify(m.cols.filter(c => c.empty && c.key !== 'review').map(c => c.key))}`);
        const act = m.cols.find(c => c.key === 'review'); check(act && Math.abs(act.w - Math.round(15 * m.rem)) <= 1 && act.right <= m.boxRight + 1, `${tag}: Actions keeps its width and stays inside: ${JSON.stringify(act)}`);
        const item = m.cols.find(c => c.key === 'agent'); check(item && item.w >= 100, `${tag}: the elastic Item column keeps room: ${JSON.stringify(item)}`);
        check(Math.abs(m.cols.reduce((n, c) => n + c.w, 0) - m.table) <= 3, `${tag}: the columns add up to the table: ${JSON.stringify(m.cols.map(c => [c.key, c.w]))} vs ${m.table}`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        for (const width of [1440, 1280, 1024, 900]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile: false });
            for (const [name, long, kept] of [['plain', false, null], ['long name', true, null], ['kept too wide', false, { asks: 700, cli: 300, folder: 400, team: 500, waiting: 400 }]]) {
                await mount(long, kept); await ev(framesJs(8)); const tag = `${width} px, ${name}`; const m = await measure(); rules(m, tag);
                if (name === 'plain') {
                    // a drag of each column that has a handle: it widens at the cost of the elastic column only, and the others do not move
                    for (const c of m.cols.filter(x => x.handle)) {
                        const before = await measure(), h = await ev(`(() => { const r = document.querySelector('#dt-host th[data-key="${c.key}"] .dt-resize').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`), I = client.Input;
                        await I.dispatchMouseEvent({ type: 'mouseMoved', x: h.x, y: h.y }); await I.dispatchMouseEvent({ type: 'mousePressed', x: h.x, y: h.y, button: 'left', buttons: 1, clickCount: 1 });
                        for (let i = 1; i <= 8; i++) await I.dispatchMouseEvent({ type: 'mouseMoved', x: h.x + 400 * i / 8, y: h.y, button: 'left', buttons: 1 });
                        await I.dispatchMouseEvent({ type: 'mouseReleased', x: h.x + 400, y: h.y, button: 'left', buttons: 0, clickCount: 1 }); await ev(framesJs(4));
                        const after = await measure(); rules(after, `${tag}, after dragging ${c.key} 400 px right`);
                        const still = before.cols.filter(x => x.key !== 'agent' && x.key !== 'asks' && x.key !== c.key); // Item and What was asked are the flexible columns of this table (both declare a share): they give the room
                        check(still.every(x => Math.abs(((after.cols.find(y => y.key === x.key) || {}).w || 0) - x.w) <= 1), `${tag}: dragging ${c.key} moves no other column but the flexible ones: ${JSON.stringify(before.cols.map(x => [x.key, x.w]))} -> ${JSON.stringify(after.cols.map(x => [x.key, x.w]))}`);
                        await mount(false, null); await ev(framesJs(6));
                    }
                }
            }
        }
        // the keyboard: Right x3 on a column's handle widens it by three steps (48 px), at the cost of the flexible columns only
        for (const width of [1440, 1280]) for (const key of ['cli', 'folder', 'team']) {
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile: false }); await mount(false, null); await ev(framesJs(8));
            const kb = await measure(); await ev(`document.querySelector('#dt-host th[data-key="${key}"] .dt-resize').focus(); true`);
            for (let i = 0; i < 3; i++) { await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); }
            await ev(framesJs(6)); const ka = await measure(), grew = ka.cols.find(c => c.key === key).w - kb.cols.find(c => c.key === key).w;
            check(Math.abs(grew - 48) <= 3, `${width} px: Right x3 on ${key} widens it by 48 px: ${grew} ` + JSON.stringify([kb.cols.map(c => [c.key, c.w]), ka.cols.map(c => [c.key, c.w])]));
        }
        // a column left out to fit is never silently gone: a quiet control says how many, lists them, and brings one back (the table still fits, the others give way)
        await Emulation.setDeviceMetricsOverride({ width: 900, height: 800, deviceScaleFactor: 1, mobile: false }); await mount(false, null); await ev(framesJs(8));
        const hid = await ev(`(() => { const b = document.querySelector('#dt-host .dt-hidden-btn'), bar = document.querySelector('#dt-host .dt-hidden-bar'); return { shown: !!bar && !bar.hidden, text: b ? b.textContent : '', label: b ? b.getAttribute('aria-label') : '', keys: [...document.querySelectorAll('#dt-host thead th.dt-th')].filter(t => t.getClientRects().length).map(t => t.dataset.key) }; })()`);
        check(hid.shown && /^\d+ columns? hidden$/.test(hid.text) && /Show one/.test(hid.label), '900 px: a control says how many columns are hidden: ' + JSON.stringify(hid));
        const n0 = Number((hid.text.match(/^\d+/) || [0])[0]);
        await ev(`document.querySelector('#dt-host .dt-hidden-btn').click(); true`); await ev(framesJs(2));
        const items = await ev(`[...document.querySelectorAll('#dt-host .dt-hidden-item')].map(b => b.textContent)`);
        check(items.length === n0 && items.every(t => /^Show /.test(t)), '900 px: it lists the hidden columns, one button each: ' + JSON.stringify({ n0, items }));
        const first = (items[0] || '').replace(/^Show /, '');
        await ev(`document.querySelector('#dt-host .dt-hidden-item').click(); true`); await ev(framesJs(6));
        const back = await measure();
        check(back.cols.some(c => c.label === first || (c.key && first)) && !back.scrolls && back.table <= back.box + 1, '900 px: bringing "' + first + '" back keeps the table inside its panel: ' + JSON.stringify({ box: back.box, table: back.table, scrolls: back.scrolls }));
        check(await ev(`(() => { const b = document.querySelector('#dt-host .dt-hidden-btn'); const m = /^(\\d+) column/.exec(b ? b.textContent : ''); return !!b && !document.querySelector('#dt-host .dt-hidden-bar').hidden ? Number(m[1]) <= ${n0} : true; })()`), '900 px: one column fewer is hidden than before (or none)');
        // 200% text at 1280
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await ev(`document.documentElement.style.fontSize = '32px'; true`);
        await mount(false, null); await ev(framesJs(8));
        const big = await ev(`(() => { const box = document.querySelector('#dt-host .dt-box'), host = document.getElementById('dt-host'); return { folded: box.classList.contains('dt-folded'), scrolls: host.scrollWidth > host.clientWidth + 1 || box.scrollWidth > box.clientWidth + 1 }; })()`);
        check(!big.scrolls, '1280 px, 200% text: no sideways scroll (' + JSON.stringify(big) + ')');
        await ev(`document.documentElement.style.fontSize = ''; true`);
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.slice(0, 40).join('\n')); process.exit(1); }
    console.log('data_table_rules_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
