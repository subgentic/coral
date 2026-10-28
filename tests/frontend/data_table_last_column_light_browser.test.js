// A resized table in the light theme (#10492, on #10443): after the last column's right edge is dragged far left, the header clip cuts what does not fit without a scrollbar over empty space, and the focus rings of the
// sort button and the resize handle sit inside that clip and are 3:1 against the header (WCAG 1.4.11). Dark and light; at 1280. A fixture table mounted in the dashboard's own page, as data_table_resize_rule does.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const problems = [];
    const SHAPE = ['name', 'state', 'team', 'progress', 'updated'];
    const mount = (shape, noGrow, narrow) => ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove(); localStorage.removeItem('coral-dt-widths:Shape');
        const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = ${narrow ? "'position:fixed;top:60px;left:20px;width:520px;bottom:20px;overflow:auto;background:var(--bg-primary);z-index:9999'" : "'position:fixed;inset:60px 20px 20px 20px;overflow:auto;background:var(--bg-primary);z-index:9999'"}; document.body.append(host);
        const rows = [{ id: 1, name: 'Fix the flaky test', state: 'Queued', team: 'alpha', progress: '2 of 4', updated: '3 min ago' }, { id: 2, name: 'Review the shared table', state: 'In progress', team: 'alpha', progress: '1 of 4', updated: '5 min ago' }];
        const def = { name: { key: 'name', label: 'Name', primary: true, width: ${noGrow ? 'undefined' : "'grow'"}, sort: true, field: 'name', cell: r => DT.primaryButton(r.name, 'Open ' + r.name) } };
        for (const k of ['state', 'team', 'progress', 'updated']) def[k] = { key: k, label: k[0].toUpperCase() + k.slice(1), sort: true, field: k }
        if (${narrow ? 'true' : 'false'}) def.team.drop = 1; // a column the narrow box drops: its <col> must go with it, or every width after it lands on the wrong column (#10443)
        const t = DT.dataTable({ label: 'Shape', columns: ${JSON.stringify(shape)}.map(k => def[k]), rows, rowKey: r => 'r' + r.id, open: () => {}, rowName: r => r.name, state: DT.tableState() });
        host.append(t.bar, t.selectButton, t.el); return true; })()`);
    const handle = key => ev(`(() => { const r = document.querySelector('#dt-host th[data-key="${key}"] .dt-resize').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const drag = async (key, dx) => { const h = await handle(key); await mouse('mouseMoved', h.x, h.y); await mouse('mousePressed', h.x, h.y); for (let i = 1; i <= 6; i++) await mouse('mouseMoved', h.x + Math.round(dx * i / 6), h.y); await mouse('mouseReleased', h.x + dx, h.y); await new Promise(r => setTimeout(r, 250)); }; // sleep-ok: the table lays out
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // the focus ring of the focused element: where it is drawn (the box grown by the outline's offset and width) against the header cell that clips it, and its colour against the header's background
    const ring = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.focus(); const cs = getComputedStyle(e), r = e.getBoundingClientRect(), th = e.closest('th').getBoundingClientRect();
        const grow = (parseFloat(cs.outlineOffset) || 0) + (parseFloat(cs.outlineWidth) || 0);
        const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
        const rgba = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const lum = c => { const t = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]; };
        let bg = [255, 255, 255, 1]; const layers = []; for (let n = e; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
        for (const c of layers.reverse()) bg = [c[0] * c[3] + bg[0] * (1 - c[3]), c[1] * c[3] + bg[1] * (1 - c[3]), c[2] * c[3] + bg[2] * (1 - c[3]), 1];
        const fg = rgba(cs.outlineColor), x = lum(fg), y = lum(bg);
        return { clipsOwnText: e.scrollWidth <= e.clientWidth + 1 || cs.overflowX !== 'visible', style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, inside: r.left - grow >= th.left - 0.5 && r.right + grow <= th.right + 0.5 && r.top - grow >= th.top - 0.5 && r.bottom + grow <= th.bottom + 0.5, ratio: Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100, fg, bg, r: [r.left, r.right], th: [th.left, th.right] }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const theme of ['light', 'dark']) {
            await setTheme(ev, theme);
            await mount(SHAPE, false); await drag('updated', -300);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Shift', windowsVirtualKeyCode: 16 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Shift', windowsVirtualKeyCode: 16 }); // a key, so the ring is the keyboard's (:focus-visible)
            const t = await ev(`(() => { const b = document.querySelector('#dt-host .dt-box'), th = b.querySelector('th[data-key="updated"]'); return { over: b.scrollWidth - b.clientWidth, thClip: getComputedStyle(th).overflowX, thW: Math.round(th.getBoundingClientRect().width), words: th.textContent.trim() }; })()`);
            if (t.over > 1) problems.push(`${theme}: the narrowed last column leaves a scrollbar over empty space (${t.over} px): ` + JSON.stringify(t));
            if (t.thClip !== 'clip') problems.push(`${theme}: the header cell clips what is wider than its column (${t.thClip})`);
            for (const [what, sel] of [['sort button', '#dt-host th[data-key="updated"] .dt-sort'], ['resize handle', '#dt-host th[data-key="updated"] .dt-resize'], ['name sort button', '#dt-host th[data-key="name"] .dt-sort']]) {
                const r = await ring(sel);
                if (!r) { problems.push(`${theme}: the ${what} is there`); continue; }
                await shot(`table-last-column-${theme}-${what.replace(/ /g, '-')}`);
                if (r.style === 'none') problems.push(`${theme}: the ${what} shows a focus ring: ` + JSON.stringify(r));
                else {
                    if (!r.clipsOwnText) problems.push(`${theme}: the ${what} draws words wider than itself, so its focus ring does not enclose them (the heading is cut outside the ring): ` + JSON.stringify(r));
                    if (!r.inside) problems.push(`${theme}: the ${what}'s focus ring is inside its header's clip: ` + JSON.stringify(r));
                    if (r.ratio < 3) problems.push(`${theme}: the ${what}'s focus ring is 3:1 against the header: ` + JSON.stringify(r));
                }
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the narrowed last column:\n  ' + problems.join('\n  '));
    console.log('PASS the last column dragged narrow is clipped cleanly and its focus rings show, light and dark');
})().catch(e => { console.error(e); process.exit(1); });
