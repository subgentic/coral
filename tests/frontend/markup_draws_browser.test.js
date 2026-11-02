// Mark up must DRAW (#11982, the Operator: "I'm unable to draw on the image"). The editor (image_markup.js) is the one every picture tray opens (a document comment, a goal comment, Request changes, the New goal form),
// so it is driven here with real input from Chrome (Input.dispatchMouseEvent and dispatchTouchEvent, not dispatched script events) on a screenshot-sized picture at 2x, for each tool, and the pixels are read back: red marks must
// be on the canvas, in the place that was dragged, and the status must count them. The pointer's capture can be refused by an engine (setPointerCapture throws, as WebKit's can for a pointer it does not know), and drawing
// must go on without it: that run fails when the editor needs the capture to start a stroke. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const reds = `(() => { const c = document.querySelector('.markup-canvas'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data; let n = 0, minX = c.width, maxX = 0, minY = c.height, maxY = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 120) { n++; const p = i / 4, px = p % c.width, py = (p - px) / c.width; if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; } return { n, minX, maxX, minY, maxY, w: c.width, h: c.height }; })()`;
    const open = async (mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: mobile ? 390 : 1280, height: mobile ? 844 : 800, deviceScaleFactor: 2, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { const c = document.createElement('canvas'); c.width = 2880; c.height = 1800; const x = c.getContext('2d'); x.fillStyle = '#2255cc'; x.fillRect(0, 0, 2880, 1800); const b = await new Promise(r => c.toBlob(r, 'image/png')); const m = await import(${S} + 'image_markup.js'); window.__done = m.openMarkup(b); return true; })()`);
        await waitFor(`!!document.querySelector('dialog.markup-dialog[open] .markup-canvas')`, 'the editor', 8000);
    };
    const rect = () => ev(`(() => { const r = document.querySelector('.markup-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const drag = async (mobile, a, b) => {
        if (mobile) {
            const t = (type, p) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }] });
            await t('touchStart', a); for (let k = 1; k <= 8; k++) await t('touchMove', { x: a.x + (b.x - a.x) * k / 8, y: a.y + (b.y - a.y) * k / 8 }); await t('touchEnd', b);
        } else {
            const m = (type, p, buttons) => client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 });
            await m('mousePressed', a, 1); for (let k = 1; k <= 8; k++) await m('mouseMoved', { x: a.x + (b.x - a.x) * k / 8, y: a.y + (b.y - a.y) * k / 8 }, 1); await m('mouseReleased', b, 0);
        }
    };
    const close = async () => { await ev(`[...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Cancel').click(); true`); await waitFor(`!document.querySelector('dialog.markup-dialog')`, 'the editor closed', 5000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, mobile, refuseCapture] of [['a mouse', false, false], ['a finger on a phone', true, false], ['a mouse where the engine refuses pointer capture', false, true], ['a finger where the engine refuses pointer capture', true, true]]) {
            await open(mobile);
            if (refuseCapture) await ev(`Element.prototype.setPointerCapture = function () { throw new DOMException('no such pointer', 'NotFoundError'); }; true`);
            for (const tool of ['pen', 'arrow', 'box']) {
                await ev(`document.querySelector('.markup-tools [data-tool="${tool}"]').click(); true`);
                const before = (await ev(reds)).n;
                const r = await rect();
                await drag(mobile, { x: r.x + r.w * 0.2, y: r.y + r.h * 0.3 }, { x: r.x + r.w * 0.7, y: r.y + r.h * 0.7 });
                const after = await ev(reds);
                assert.ok(after.n > before + 50, `${label}, ${tool}: red marks are on the canvas (${before} -> ${after.n})`);
                // they are where the drag was: inside the picture's box between 15% and 75% of each side, never off at a corner
                assert.ok(after.minX >= after.w * 0.15 && after.maxX <= after.w * 0.75 && after.minY >= after.h * 0.25 && after.maxY <= after.h * 0.75, `${label}, ${tool}: the marks are where it was dragged ${JSON.stringify(after)}`);
                await ev(`document.querySelector('.markup-controls button:not([data-tool])').click(); true`); // Undo: the next tool starts from a clean picture
                assert.equal((await ev(reds)).n, before, `${label}, ${tool}: Undo takes the mark off`);
            }
            const r2 = await rect();
            await drag(mobile, { x: r2.x + r2.w * 0.3, y: r2.y + r2.h * 0.4 }, { x: r2.x + r2.w * 0.6, y: r2.y + r2.h * 0.6 });
            assert.match(await ev(`document.querySelector('.markup-status').textContent`), /^1 mark$/, `${label}: the status counts the mark`);
            assert.equal(await ev(`document.querySelector('.markup-foot .btn-primary').disabled`), false, `${label}: Done is ready`);
            await close();
            console.log(`   ✓ ${label}`);
        }
        // a stroke whose release never came (the pointer let go over another window) does not lock the editor: the next press draws
        await open(false);
        const r3 = await rect();
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r3.x + r3.w * 0.1, y: r3.y + r3.h * 0.1, button: 'left', buttons: 1, clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: r3.x + r3.w * 0.2, y: r3.y + r3.h * 0.2, buttons: 1 });
        await ev(`window.dispatchEvent(new Event('blur')); true`); // no release is ever delivered
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r3.x + r3.w * 0.2, y: r3.y + r3.h * 0.2, button: 'left', buttons: 0, clickCount: 1 });
        const stale = (await ev(reds)).n;
        await drag(false, { x: r3.x + r3.w * 0.4, y: r3.y + r3.h * 0.4 }, { x: r3.x + r3.w * 0.8, y: r3.y + r3.h * 0.8 });
        assert.ok((await ev(reds)).n > stale, 'after a stroke that was cut short the next one still draws');
        await close();
        console.log('PASS Mark up draws pen, arrow and box with a real mouse and a real finger, with or without pointer capture');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
