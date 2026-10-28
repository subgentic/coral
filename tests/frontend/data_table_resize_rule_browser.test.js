// A column separator changes ONLY the column to its left (the Operator's rule, #9228). The other columns keep their widths; what the column gives or takes comes from the flexible name column, or, with
// no flexible column left, the table is as wide as its columns (it scrolls inside its box when that is wider than the box) and never ends short of the box's edge: the last column that can be resized fills what the others leave (#10443). Mouse and keyboard, on a table shaped
// like Inbox Goals (the name column first) and like Inbox Tasks and the team Tasks tab (the name column in the middle), at 1280. The failing case: the flexible column's own separator dragged left used to hand its width
// to every other column (a fixed table at 100% spreads what is left over all of them). Drives Chrome over CDP against the isolated dev server; a fixture table mounted in the dashboard's own page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const SHAPES = {
        'name first (Inbox Goals)': ['name', 'state', 'team', 'progress', 'updated'],
        'name in the middle (Inbox Tasks)': ['state', 'name', 'team', 'updated'],
        'no flexible column (Inbox Needs you)': ['name', 'state', 'team', 'updated'], // every column has a width the first time one is dragged
    };
    const mount = (shape, noGrow) => ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove(); localStorage.removeItem('coral-dt-widths:Shape');
        const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = 'position:fixed;inset:60px 20px 20px 20px;overflow:auto;background:var(--bg-primary);z-index:9999'; document.body.append(host);
        const rows = [{ id: 1, name: 'Fix the flaky test', state: 'Queued', team: 'alpha', progress: '2 of 4', updated: '3 min ago' }, { id: 2, name: 'Review the shared table', state: 'In progress', team: 'alpha', progress: '1 of 4', updated: '5 min ago' }];
        const def = { name: { key: 'name', label: 'Name', primary: true, width: ${noGrow ? 'undefined' : "'grow'"}, sort: true, field: 'name', cell: r => DT.primaryButton(r.name, 'Open ' + r.name) } };
        for (const k of ['state', 'team', 'progress', 'updated']) def[k] = { key: k, label: k[0].toUpperCase() + k.slice(1), sort: true, field: k };
        const t = DT.dataTable({ label: 'Shape', columns: ${JSON.stringify(shape)}.map(k => def[k]), rows, rowKey: r => 'r' + r.id, open: () => {}, rowName: r => r.name, state: DT.tableState() });
        host.append(t.bar, t.selectButton, t.el); return true; })()`);
    const widths = () => ev(`(() => { const b = document.querySelector('#dt-host .dt-box'); return { cols: Object.fromEntries([...b.querySelectorAll('thead th')].filter(t => t.getBoundingClientRect().width > 0).map(t => [t.dataset.key || 'check', Math.round(t.getBoundingClientRect().width)])), sw: b.scrollWidth, cw: b.clientWidth, table: Math.round(b.querySelector('table').getBoundingClientRect().width) }; })()`);
    const handle = key => ev(`(() => { const r = document.querySelector('#dt-host th[data-key="${key}"] .dt-resize').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const drag = async (key, dx) => { const h = await handle(key); await mouse('mouseMoved', h.x, h.y); await mouse('mousePressed', h.x, h.y); for (let i = 1; i <= 6; i++) await mouse('mouseMoved', h.x + Math.round(dx * i / 6), h.y); await mouse('mouseReleased', h.x + dx, h.y); await new Promise(r => setTimeout(r, 250)); }; // sleep-ok: the table lays out
    const press = async (key, k, n) => { await ev(`document.querySelector('#dt-host th[data-key="${key}"] .dt-resize').focus(); true`); for (let i = 0; i < n; i++) { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, windowsVirtualKeyCode: k === 'ArrowRight' ? 39 : 37 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, windowsVirtualKeyCode: k === 'ArrowRight' ? 39 : 37 }); } await new Promise(r => setTimeout(r, 250)); }; // sleep-ok: the table lays out
    // what changed between two measures: { key: delta } for the columns that moved more than a pixel
    const moved = (a, b) => Object.fromEntries(Object.keys(a.cols).map(k => [k, b.cols[k] - a.cols[k]]).filter(([, d]) => Math.abs(d) > 1));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [name, shape] of Object.entries(SHAPES)) {
            const keys = shape.filter(k => k !== 'name' || true);
            for (const key of shape) for (const dx of [60, -60, 300]) {
                await mount(shape, name.startsWith('no flexible')); const before = await widths();
                await drag(key, dx); const after = await widths(), d = moved(before, after);
                const lastKey = shape[shape.length - 1], others = Object.keys(d).filter(k => k !== key && k !== 'name' && k !== lastKey);
                check(`${name}: dragging ${key} by ${dx} changes only ${key}${key === 'name' ? '' : ' (and the name column gives or takes the room)'}`, others.length === 0 && (key === 'name' ? true : Math.abs(d[key] || 0) > 0 || dx < 0), JSON.stringify(d));
            }
            for (const [key, k] of [[shape[1], 'ArrowRight'], [shape[2], 'ArrowLeft'], ['name', 'ArrowLeft']]) {
                await mount(shape, name.startsWith('no flexible')); const before = await widths();
                await press(key, k, 3); const after = await widths(), d = moved(before, after);
                const lastKey = shape[shape.length - 1], others = Object.keys(d).filter(kk => kk !== key && kk !== 'name' && kk !== lastKey);
                check(`${name}: ${k} x3 on the ${key} separator changes only ${key}`, others.length === 0 && Object.keys(d).includes(key), JSON.stringify(d));
            }
            // the Operator's #10443: the last column's right edge dragged left (and by keys) fills to the box's edge: the table is not short of its box, no scrollbar over empty space, the last column holds the room
            for (const how of ['drag', 'keys']) {
                await mount(shape, name.startsWith('no flexible')); const lastKey = shape[shape.length - 1];
                if (how === 'drag') await drag(lastKey, -300); else await press(lastKey, 'ArrowLeft', 12);
                const w = await widths(), edge = await ev(`(() => { const b = document.querySelector('#dt-host .dt-box'), th = b.querySelector('th[data-key="${lastKey}"]'); return { box: Math.round(b.getBoundingClientRect().right - parseFloat(getComputedStyle(b).borderRightWidth || 0)), last: Math.round(th.getBoundingClientRect().right), left: b.scrollLeft }; })()`);
                check(`${name}: the last column (${lastKey}), ${how === 'drag' ? 'dragged left' : 'narrowed by keys'}, still fills to the box's edge: no short table, no scrollbar`, w.table >= w.cw - 1 && w.sw <= w.cw + 1 && Math.abs(edge.box - edge.last) <= 2 && edge.left === 0, JSON.stringify({ table: w.table, cw: w.cw, sw: w.sw, ...edge }));
            }
            await mount(shape, name.startsWith('no flexible')); const w0 = await widths(); await drag('name', 200); const w1 = await widths();
            check(`${name}: the name column widened past the box: the table scrolls inside its box and the others keep their widths`, w1.sw > w1.cw && Object.keys(moved(w0, w1)).every(k => k === 'name'), JSON.stringify({ sw: w1.sw, cw: w1.cw, moved: moved(w0, w1) }));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} column-resize checks passed`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
