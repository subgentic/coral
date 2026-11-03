// #12754: the actual shared Artifacts builder supports drag, reload, keyboard and phone behavior.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const mount = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { const { artifactTable } = await import((window.__coralStatic || '/static/') + 'artifact_table.js'); const host = document.createElement('main'); host.id = 'resize-fixture'; host.style.cssText = 'width:940px;max-width:100%;margin:auto'; document.body.replaceChildren(host); const rows = [1,2].map(n => ({ id: String(n).padStart(64,'0'), name: n === 1 ? 'alpha-report.md' : 'beta-image.png', media_type: n === 1 ? 'text/markdown' : 'image/png', size: n*1024, created_at: '2026-11-01T00:00:00Z', tags: ['review'], available: true, uri: 'coral://artifacts/' + String(n).padStart(64,'0') })); const table = artifactTable({ label: 'Artifacts, 2', rows, details: () => 'Details' }); host.append(table.el); return true; })()`);
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
        await mount(); if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/artifacts-resize.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); } const before = await width('name'); await drag('name',40); const after = await width('name');
        assert.ok(after >= before+35, 'drag moves the boundary: '+JSON.stringify({before,after}));
        await mount(); assert.ok(Math.abs(await width('name')-after)<=2,'widths remembered after page reload');
        const kind = await width('type'); await ev(`document.querySelector('#resize-fixture th[data-key=type] .dt-resize').focus(); true`);
        await client.Input.dispatchKeyEvent({type:'keyDown',key:'ArrowRight'}); await client.Input.dispatchKeyEvent({type:'keyUp',key:'ArrowRight'}); await ev(framesJs(4));
        assert.ok(await width('type')>=kind+14,'keyboard uses the shared resize');
        for (let i=0;i<8;i++) { await client.Input.dispatchKeyEvent({type:'keyDown',key:'ArrowRight'}); await client.Input.dispatchKeyEvent({type:'keyUp',key:'ArrowRight'}); } await ev(framesJs(4)); const wide = await width('type');
        await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter'}); await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter'}); await ev(framesJs(4));
        assert.ok(await width('type')<wide,'Enter fits an over-wide column to its content');
        assert.equal(await ev(`document.querySelector('#resize-fixture th[data-key=updated]').getAttribute('aria-sort')`),'descending','drag and keyboard resize preserve sorting');
        await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true}); await Emulation.setTouchEmulationEnabled({enabled:true}); await ev(framesJs(6));
        assert.equal(await ev(`[...document.querySelectorAll('.dt-resize')].filter(h=>!h.hidden && h.getClientRects().length).length`),0,'phone has no visible handles');
        assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth`),'phone does not overflow');
    } finally { await client.close(); }
    console.log('artifacts_columns_resize_browser: ok');
})().catch(e=>{console.error(e);process.exit(1)});
