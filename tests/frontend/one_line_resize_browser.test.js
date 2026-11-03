// #12754: one-line lists can opt into the same resize contract without changing phone rows.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const mount = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { const DT = await import((window.__coralStatic || '/static/') + 'data_table.js'); const host = document.createElement('main'); host.id = 'resize-fixture'; host.style.cssText = 'width:900px;max-width:100%;margin:auto'; document.body.replaceChildren(host); const rows = [{ id: 1, name: 'First document', kind: 'Text', updated: 'Yesterday' }, { id: 2, name: 'Second document', kind: 'Image', updated: 'Today' }]; const table = DT.dataTable({ label: 'One-line resize proof', widthsKey: 'one-line-proof', oneLine: true, resize: true, rows, rowKey: r => r.id, columns: [{ key: 'name', label: 'Name', primary: true, width: 'grow', sort: true, cell: r => r.name }, { key: 'kind', label: 'Type', width: '12rem', dropAt: 36, sort: true, cell: r => r.kind }, { key: 'updated', label: 'Updated', width: '10rem', cell: r => r.updated }, { key: 'actions', label: 'Actions', fixed: true, width: '8rem', cell: () => 'Open' }] }); host.append(table.el); return true; })()`);
        await ev(framesJs(6));
    };
    const width = key => ev(`Math.round(document.querySelector('#resize-fixture th[data-key="${key}"]').getBoundingClientRect().width)`);
    const drag = async (key, dx) => {
        const p = await ev(`(() => { const h = document.querySelector('#resize-fixture th[data-key="${key}"] .dt-resize'); if (!h || !h.getClientRects().length) return null; const r = h.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top+r.height/2 }; })()`);
        assert.ok(p, key + ' has the shared handle');
        for (const [type,x] of [['mouseMoved',p.x],['mousePressed',p.x],['mouseMoved',p.x+dx],['mouseReleased',p.x+dx]]) await client.Input.dispatchMouseEvent({ type, x, y:p.y, button:'left', buttons:type==='mouseReleased'?0:1, clickCount:1 });
        await ev(framesJs(5));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width:1280,height:800,deviceScaleFactor:1,mobile:false }); await Emulation.setTouchEmulationEnabled({enabled:false});
        await mount(); const before = await width('name'); await drag('name',40); const after = await width('name');
        assert.ok(after >= before+35, 'drag moves the boundary: '+JSON.stringify({before,after}));
        await mount(); assert.ok(Math.abs(await width('name')-after)<=2,'widths remembered after page reload');
        const kind = await width('kind'); await ev(`document.querySelector('#resize-fixture th[data-key=kind] .dt-resize').focus(); true`);
        await client.Input.dispatchKeyEvent({type:'keyDown',key:'ArrowRight'}); await client.Input.dispatchKeyEvent({type:'keyUp',key:'ArrowRight'}); await ev(framesJs(4));
        assert.ok(await width('kind')>=kind+14,'keyboard uses the shared resize');
        await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter'}); await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter'}); await ev(framesJs(4));
        assert.ok(await width('kind')<kind,'Enter fits the content');
        await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true}); await Emulation.setTouchEmulationEnabled({enabled:true}); await ev(framesJs(6));
        assert.equal(await ev(`[...document.querySelectorAll('.dt-resize')].filter(h=>!h.hidden && h.getClientRects().length).length`),0,'phone has no visible handles');
        assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth`),'phone does not overflow');
    } finally { await client.close(); }
    console.log('one_line_resize_browser: ok');
})().catch(e=>{console.error(e);process.exit(1)});
