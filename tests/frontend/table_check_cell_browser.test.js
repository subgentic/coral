// A table's select checkbox is whole in its cell (#9073, the Operator's shot of Inbox Artifacts): the select column leaves room for the box, its 44 px target and its focus ring, so no edge of the box is clipped by the cell, in the
// header and in a row, in the shared one-line table at 1280 and 390 (the table every artifact list uses). The table is mounted from data_table.js on the isolated dev server's page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(async () => { const DT = await import(${S} + 'data_table.js'); let h = document.getElementById('chk-host'); if (h) h.remove(); h = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'chk-host', style: 'position:fixed;inset:0;z-index:50;background:var(--bg-primary);padding:24px' }));
                const rows = [1, 2, 3].map(i => ({ id: 'r' + i, name: 'file-' + i + '.txt' }));
                const t = DT.dataTable({ label: 'Files', oneLine: true, selectable: true, rows, rowKey: r => r.id, rowName: r => r.name, columns: [{ key: 'name', label: 'Name', primary: true, width: 'grow', cell: r => DT.primaryButton(r.name) }, { key: 'size', label: 'Size', width: '5rem', cell: r => '12 KB' }] });
                h.append(t.el); return true; })()`);
            await waitFor(`document.querySelectorAll('#chk-host .dt-check input').length >= 2`, 'the select column', 8000);
            await ev(`(() => { const b = document.querySelector('#chk-host .dt-select-toggle'); if (b && b.textContent === 'Select') b.click(); return true; })()`);
            await ev(`document.querySelector('#chk-host tbody .dt-check input').focus({ focusVisible: true }); true`);
            const g = await ev(`(() => { const one = (sel) => { const i = document.querySelector(sel + ' input'), c = document.querySelector(sel), ir = i.getBoundingClientRect(), cr = c.getBoundingClientRect(), cs = getComputedStyle(c); return { inLeft: Math.round(ir.left - cr.left), inRight: Math.round(cr.right - ir.right), cellW: Math.round(cr.width), box: Math.round(ir.width), overflow: cs.overflowX, display: cs.display }; }; return { head: one('#chk-host thead .dt-check'), row: one('#chk-host tbody .dt-check') }; })()`);
            for (const [name, c] of Object.entries(g)) {
                assert.ok(c.inLeft >= 0 && c.inRight >= 0, at + `the ${name} checkbox is inside its cell on both sides: ` + JSON.stringify(c));
                assert.ok(c.cellW >= 44, at + `the ${name} select cell has room for a 44 px target and its focus ring: ` + JSON.stringify(c));
                assert.notEqual(c.overflow, 'hidden', at + `the ${name} cell does not clip: ` + JSON.stringify(c));
            }
            await shot(`table-check-cell-${w}`);
        }
        console.log('PASS table select checkbox: whole in its cell, 44 px of room, nothing clipped, 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
