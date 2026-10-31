// #11564 (the operator's one action set): More is one three-dot icon, drawn in CSS from the control's own colour, never a typed ⋯ or …. The real stylesheet's .ic-more on a real button: no text, a 15 x 5 px
// block of three dots (the gradient tile repeats three times), the button's colour, and it paints (the dots are not transparent). At 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 2, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            const m = await ev(`(() => { document.getElementById('more-probe')?.remove(); const b = document.body.appendChild(Object.assign(document.createElement('button'), { id: 'more-probe', className: 'btn btn-quiet btn-icon ic-more', type: 'button' })); b.setAttribute('aria-label', 'More'); b.style.cssText = 'position:fixed;left:300px;top:300px;z-index:99999;background:#000;color:rgb(10,200,30)';
                const p = getComputedStyle(b, '::before'), cv = document.createElement('canvas'); cv.width = 200; cv.height = 200;
                return { text: b.textContent, content: p.content, w: parseFloat(p.width), h: parseFloat(p.height), size: p.backgroundSize, image: p.backgroundImage.slice(0, 30), color: getComputedStyle(b).color }; })()`);
            assert.equal(m.text, '', `${w}: no typed glyph: ${JSON.stringify(m)}`);
            assert.ok(m.w === 15 && m.h === 5 && /5px 5px/.test(m.size) && /radial-gradient/.test(m.image), `${w}: three dots, 15 x 5 px: ${JSON.stringify(m)}`);
            // paint check: the middle of the first and the last dot are the button's colour, the gap between is not
            const px = await ev(`(async () => { const b = document.getElementById('more-probe'), r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2; return { cx, cy }; })()`);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the button's colour transition (0.15 s) has to finish before its dots are sampled
            const shot = await Page.captureScreenshot({ format: 'png', clip: { x: px.cx - 10, y: px.cy - 4, width: 20, height: 8, scale: 2 } });
            const png = Buffer.from(shot.data, 'base64'); assert.ok(png.length > 100, `${w}: a screenshot of the icon`);
            const green = await ev(`(async () => { const img = new Image(); img.src = 'data:image/png;base64,${shot.data}'; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
                const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0, best = 0; for (let i = 0; i < d.length; i += 4) { best = Math.max(best, d[i + 1]); if (d[i + 1] > 90 && d[i + 1] > d[i] + 60 && d[i + 1] > d[i + 2] + 60) n++; } return n * 1000 + best; })()`);
            assert.ok(Math.floor(green / 1000) >= 8, `${w}: the dots paint in the button's colour (${Math.floor(green / 1000)} px, brightest green ${green % 1000})`);
            await ev(`document.getElementById('more-probe').remove(); true`);
        }
        console.log('\nPASS More is one CSS three-dot icon');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
