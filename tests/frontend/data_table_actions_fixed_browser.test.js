// A list's Actions column is never clipped (#9845, the operator via coral-hub's #9839): it is a fixed column (fixed: true with a rem width): no resize handle, never frozen or kept, so a width saved when the list had fewer buttons, or another column's resize, cannot squeeze
// its buttons (the third Needs you action was cut off). Also: there is no Reset column widths button. A fixture table in the dashboard's own page, 1280 px; CORAL_SCREENSHOT_DIR saves the picture. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const KEY = 'coral-dt-widths:ActionsFixture';
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const mount = fixed => ev(`(async () => { const DT = await import(${MOD} + 'data_table.js'); document.getElementById('dt-host')?.remove();
        const host = document.createElement('div'); host.id = 'dt-host'; host.style.cssText = 'position:fixed;inset:60px 20px 20px 20px;overflow:auto;background:var(--bg-primary);z-index:9999'; document.body.append(host);
        const rows = [{ id: 1, name: 'Review of the release plan', who: 'Dev' }, { id: 2, name: 'Approve the budget', who: 'QA' }];
        const btns = r => { const w = document.createElement('span'); w.style.cssText = 'display:inline-flex;gap:8px'; for (const t of ['Open', 'Undo', 'Done']) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-small'; b.style.minWidth = '72px'; b.textContent = t; w.append(b); } return w; };
        const cols = [{ key: 'name', label: 'Name', primary: true, width: 'grow', line: 1, field: 'name', cell: r => DT.primaryButton(r.name, 'Open ' + r.name) }, { key: 'who', label: 'Who', line: 2, field: 'who', cell: r => DT.avatar(r.who) },
            { key: 'act', label: 'Actions', ${'${fixed}'} width: '19rem', line: 1, cell: btns }];
        const t = DT.dataTable({ label: 'ActionsFixture', columns: cols, rows, rowKey: r => 'r' + r.id, open: () => {}, rowName: r => r.name, state: DT.tableState() });
        host.append(t.bar, t.selectButton, t.el); return true; })()`.replace('${fixed}', fixed ? 'fixed: true,' : ''));
    const measure = () => ev(`(() => { const th = document.querySelector('#dt-host th[data-key="act"]'), box = document.querySelector('#dt-host .dt-box').getBoundingClientRect(), td = document.querySelector('#dt-host tbody tr td:last-child'), bs = [...td.querySelectorAll('button')].map(b => b.getBoundingClientRect());
        return { thW: Math.round(th.getBoundingClientRect().width), handle: !!th.querySelector('.dt-resize'), lastRight: Math.round(Math.max(...bs.map(b => b.right))), tdRight: Math.round(td.getBoundingClientRect().right), boxRight: Math.round(box.right), cellClipped: td.scrollWidth > td.clientWidth + 1, kept: localStorage.getItem(${JSON.stringify(KEY)}) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        // a width kept when the Actions column was narrower (it had two buttons), and another column's kept width: both are in storage before the table is drawn
        await ev(`localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify({ name: 360, who: 140, act: 150 })); true`);
        await mount(true);
        const m = await measure();
        assert.ok(Math.abs(m.thW - 304) <= 2, 'the Actions column has the 19 rem it declares, not the 150 px kept for it: ' + JSON.stringify(m));
        assert.equal(m.handle, false, 'a fixed column has no resize handle');
        assert.ok(m.lastRight <= m.tdRight + 1 && m.lastRight <= m.boxRight && !m.cellClipped, 'the third action is whole, inside its cell and inside the table: ' + JSON.stringify(m));
        assert.equal(await ev(`!!document.querySelector('#dt-host .dt-reset-widths, #dt-host .dt-widthbar') || /Reset column widths/.test(document.getElementById('dt-host').textContent)`), false, 'there is no Reset column widths button');
        await shot('table-actions-fixed-1280');
        // resizing another column keeps nothing for the fixed one
        await ev(`localStorage.removeItem(${JSON.stringify(KEY)}); true`); await mount(true);
        const h = await ev(`(() => { const r = document.querySelector('#dt-host th[data-key="who"] .dt-resize').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
        await mouse('mouseMoved', h.x, h.y); await mouse('mousePressed', h.x, h.y); for (let i = 1; i <= 4; i++) await mouse('mouseMoved', h.x + 50 * i, h.y); await mouse('mouseReleased', h.x + 200, h.y);
        const m2 = await measure();
        assert.ok(Math.abs(m2.thW - 304) <= 2 && m2.lastRight <= m2.boxRight && !m2.cellClipped, 'after widening Who the Actions column is the same width and whole: ' + JSON.stringify(m2));
        assert.ok(m2.kept && !('act' in JSON.parse(m2.kept)) && 'who' in JSON.parse(m2.kept), 'the width kept is Who\'s, never the fixed column\'s: ' + m2.kept);
        await ev(`localStorage.removeItem(${JSON.stringify(KEY)}); true`);
        console.log('PASS the fixed Actions column is never clipped and nothing resets it');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
