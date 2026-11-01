// #11654 (Goal #184 slice 2): the image markup editor. The real image_markup.js and stylesheet on the isolated dev server at 1280 (a real mouse) and 390 px (a real touch): the dialog opens on a picture with Pen, Arrow and
// Box and Undo; Done is off until there is a mark; a box, an arrow and a pen stroke are drawn; Undo drops the last; Done resolves a PNG at the picture's own size whose pixels are the mark colour where each stroke was and the
// picture's own colour elsewhere; Cancel and Escape resolve null. The module is lazy: the first-load bytes are page_weight_browser's.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const IMG = { w: 400, h: 250 };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            const open = () => ev(`(async () => { const c = document.createElement('canvas'); c.width = ${IMG.w}; c.height = ${IMG.h}; const x = c.getContext('2d'); x.fillStyle = '#0000ff'; x.fillRect(0, 0, c.width, c.height);
                const blob = await new Promise(r => c.toBlob(r, 'image/png')); const m = await import(${S} + 'image_markup.js'); window.__mk = m.openMarkup(blob); window.__done = undefined; window.__mk.then(v => { window.__done = v === null ? 'null' : v; }); return true; })()`);
            const dlg = `document.querySelector('dialog.markup-dialog')`;
            const cv = () => ev(`(() => { const r = document.querySelector('.markup-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
            const pt = (r, fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
            const drag = async (a, b) => {
                if (mobile) {
                    const t = (type, p) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }] });
                    await t('touchStart', a); for (let i = 1; i <= 6; i++) await t('touchMove', { x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 }); await t('touchEnd', b);
                } else {
                    const m = (type, p, buttons) => client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 });
                    await m('mousePressed', a, 1); for (let i = 1; i <= 6; i++) await m('mouseMoved', { x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 }, 1); await m('mouseReleased', b, 0);
                }
            };
            const tool = name => ev(`document.querySelector('${'.markup-tools [data-tool="' + name + '"]'}').click(); true`);
            const status = () => ev(`document.querySelector('.markup-status').textContent`);

            // Cancel and Escape give null
            await open(); await waitFor(`!!${dlg} && ${dlg}.open`, at + 'the editor opens', 8000);
            assert.equal(await ev(`${dlg}.getAttribute('aria-labelledby') && document.getElementById(${dlg}.getAttribute('aria-labelledby')).textContent`), 'Mark up image', at + 'the dialog is named');
            assert.deepEqual(await ev(`[...document.querySelectorAll('.markup-tools button')].map(b => b.textContent)`), ['Pen', 'Arrow', 'Box'], at + 'three tools');
            assert.equal(await ev(`[...document.querySelectorAll('.markup-bar button, .markup-foot button')].find(b => b.textContent === 'Done').disabled`), true, at + 'Done waits for a mark');
            await ev(`[...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Cancel').click(); true`);
            await waitFor(`window.__done === 'null' && !${dlg}`, at + 'Cancel resolves null and closes', 5000);
            await open(); await waitFor(`!!${dlg} && ${dlg}.open`, at + 'opens again', 8000);
            await ev(`${dlg}.dispatchEvent(new Event('cancel', { cancelable: true })); true`);
            await waitFor(`window.__done === 'null' && !${dlg}`, at + 'Escape resolves null', 5000);

            // a box, an arrow and a pen stroke, then undo the pen stroke
            await open(); await waitFor(`!!${dlg} && ${dlg}.open`, at + 'opens for drawing', 8000);
            if (mobile) assert.ok((await ev(`${dlg}.getBoundingClientRect().width`)) >= w - 1 && (await ev(`${dlg}.getBoundingClientRect().height`)) >= h - 1, at + 'the whole screen on a phone');
            const r = await cv();
            assert.ok(r.w > 100 && r.x >= 0 && r.x + r.w <= w + 1, at + 'the picture fits the screen: ' + JSON.stringify(r));
            await tool('box'); await drag(pt(r, 0.1, 0.2), pt(r, 0.5, 0.6));
            assert.equal(await status(), '1 mark', at + 'one mark after the box');
            await tool('arrow'); await drag(pt(r, 0.6, 0.8), pt(r, 0.9, 0.5));
            await tool('pen'); await drag(pt(r, 0.15, 0.85), pt(r, 0.45, 0.9));
            assert.equal(await status(), '3 marks', at + 'three marks');
            await ev(`[...document.querySelectorAll('.markup-bar button')].find(b => b.textContent === 'Undo').click(); true`);
            assert.equal(await status(), '2 marks', at + 'Undo drops the pen stroke');
            await ev(`[...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Done').click(); true`);
            await waitFor(`window.__done && window.__done !== 'null' && !${dlg}`, at + 'Done resolves a picture and closes', 8000);
            // the picture: size, the box edge and the arrow shaft are the mark colour, the pen stroke is gone, the rest is the picture's blue
            const px = await ev(`(async () => { const b = window.__done, bmp = await createImageBitmap(b), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
                const at = (fx, fy) => { const d = x.getImageData(Math.round(fx * (c.width - 1)), Math.round(fy * (c.height - 1)), 1, 1).data; return [d[0], d[1], d[2]]; };
                return { type: b.type, w: bmp.width, h: bmp.height, boxLeft: at(0.1, 0.4), boxTop: at(0.3, 0.2), shaft: at(0.75, 0.65), penGone: at(0.3, 0.875), inside: at(0.3, 0.4), outside: at(0.9, 0.1) }; })()`);
            const red = c => c[0] > 180 && c[1] < 120 && c[2] < 120, blue = c => c[2] > 230 && c[0] < 30 && c[1] < 30;
            assert.equal(px.type, 'image/png', at + 'a PNG');
            assert.deepEqual([px.w, px.h], [IMG.w, IMG.h], at + "at the picture's own size: " + JSON.stringify(px));
            assert.ok(red(px.boxLeft) && red(px.boxTop), at + 'the box edges are the mark colour: ' + JSON.stringify(px));
            assert.ok(red(px.shaft), at + 'the arrow shaft is the mark colour: ' + JSON.stringify(px));
            assert.ok(blue(px.penGone) && blue(px.inside) && blue(px.outside), at + 'the undone stroke and the rest of the picture are untouched: ' + JSON.stringify(px));
        }
        console.log('\nPASS the image markup editor');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
