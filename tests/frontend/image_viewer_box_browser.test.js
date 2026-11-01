// The artifact viewer's picture box, and the side preview's and the Before/After diff's (#11702, #11711, the operator: a 2740x570 screenshot got a short box sized to its ratio and was drawn at 57% inside it): the box fills the viewer body whatever the picture's shape (wide, tall, small); the
// picture sits in its middle at its own size up to the box (a small one is not blown up); zooming pans inside the box and the box does not change size; the wheel and a pinch zoom around the pointer, a drag pans, and the keyboard
// zooms (+ - 0) and moves (arrows). 1440 and 390. The artifact's bytes are drawn in the page and answered by a stub. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SIZES = { wide: [2740, 570], tall: [400, 1600], small: [48, 48] };
const hexOf = n => String(n).padStart(64, '0');
const pct = (fit, k) => `${Math.round(k * fit * 100)}%`; // the zoom reads the picture's real scale: the fit times the zoom (#11787)

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const real = window.fetch, sizes = ${JSON.stringify(SIZES)}, ids = { '${hexOf(1)}': 'wide', '${hexOf(2)}': 'tall', '${hexOf(3)}': 'small' };
                const png = (n) => new Promise(r => { const [cw, ch] = sizes[n], c = document.createElement('canvas'); c.width = cw; c.height = ch; const g = c.getContext('2d'); g.fillStyle = '#3a6ea5'; g.fillRect(0, 0, cw, ch); g.fillStyle = '#e8a33d'; g.fillRect(cw / 4, ch / 4, cw / 2, ch / 2); c.toBlob(r, 'image/png'); });
                window.fetch = async (u, o = {}) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/artifacts\\/([0-9a-f]{64})$/.exec(url.pathname);
                    if (m && ids[m[1]] && (o.method || 'GET') === 'GET') return new Response(await png(ids[m[1]]), { status: 200, headers: { 'content-type': 'image/png' } });
                    if (/^\\/api\\/artifacts\\/[0-9a-f]{64}\\/(versions|meta|readers|comments)/.test(url.pathname)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
                    return real(u, o); };
                const draw = (n) => { const [cw, ch] = sizes[n], c = document.createElement('canvas'); c.width = cw; c.height = ch; const g = c.getContext('2d'); g.fillStyle = '#3a6ea5'; g.fillRect(0, 0, cw, ch); g.fillStyle = '#e8a33d'; g.fillRect(cw / 4, ch / 4, cw / 2, ch / 2); return c.toDataURL('image/png'); };
                const urls = Object.fromEntries(Object.entries(ids).map(([h, n]) => [h, draw(n)])), d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
                Object.defineProperty(HTMLImageElement.prototype, 'src', { ...d, set(v) { const m = /\\/api\\/artifacts\\/([0-9a-f]{64})/.exec(String(v)); d.set.call(this, m && urls[m[1]] ? urls[m[1]] : v); } });
                return true; })()`);
            for (const [i, name] of [[1, 'wide'], [2, 'tall'], [3, 'small']]) {
                const at = `${w} px, ${name}: `;
                await ev(`import(${S} + 'artifact_viewer.js').then(m => { m.openArtifactViewer('${hexOf(i)}', { filename: '${name}.png' }); return true; })`);
                await waitFor(`(() => { const im = document.querySelector('.artifact-viewer .image-pane-frame img'); return !!im && im.complete && im.naturalWidth > 0; })()`, at + 'the picture loads', 10000);
                await ev(`new Promise(r => setTimeout(r, 250))`); // sleep-ok: the viewer lays out after the picture arrives
                const g = await ev(`(() => { const body = document.querySelector('.artifact-viewer-body'), f = document.querySelector('.artifact-viewer .image-pane-frame'), im = f.querySelector('img'), b = body.getBoundingClientRect(), fr = f.getBoundingClientRect(), ir = im.getBoundingClientRect(), cs = getComputedStyle(body), padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
                    return { bodyW: b.width - padX, bodyH: b.height - padY, frameW: fr.width, frameH: fr.height, imgW: ir.width, imgH: ir.height, natW: im.naturalWidth, natH: im.naturalHeight, centred: Math.abs((ir.left + ir.width / 2) - (fr.left + fr.width / 2)) < 2 && Math.abs((ir.top + ir.height / 2) - (fr.top + 18 + fr.height / 2)) < 2 }; })()`);
                check(g.frameW >= g.bodyW * 0.9 && g.frameH >= g.bodyH * 0.88, at + `the box fills the viewer body (all but its caption line): ${JSON.stringify(g)}`); // the old box was as high as the picture's ratio: 187 px of 614 for the wide one
                check(g.centred, at + 'the picture is in the middle of the box');
                if (name === 'wide') check(g.imgW >= g.frameW * 0.9, at + `a wide picture fits the box's width: ${Math.round(g.imgW)} of ${Math.round(g.frameW)}`);
                if (name === 'tall') check(g.imgH >= (g.frameH - 52) * 0.95, at + `a tall picture fits the box's height: ${Math.round(g.imgH)} of ${Math.round(g.frameH)}`);
                if (name === 'small') check(Math.round(g.imgW) <= g.natW + 1, at + `a small picture is not blown up: ${Math.round(g.imgW)} of ${g.natW}`);
                const L = await ev(`(() => { const f = document.querySelector('.artifact-viewer .image-pane-frame'), im = f.querySelector('img'), c = document.querySelector('.artifact-viewer .image-zoom-controls').getBoundingClientRect(), ir = im.getBoundingClientRect(); return { level: document.querySelector('.artifact-viewer .image-zoom-level').textContent, drawn: Math.round(im.clientWidth / im.naturalWidth * 100) + '%', cBottom: c.bottom, iTop: ir.top, nat: im.naturalWidth, w: im.clientWidth }; })()`);
                check(L.level === L.drawn, at + `the zoom reads the picture's real scale (${L.w} px drawn of ${L.nat}): ${JSON.stringify(L)}`);
                check(L.iTop >= L.cBottom - 1, at + `the controls are above the picture, not over it: ${JSON.stringify(L)}`);
                await shot(`image-viewer-${name}-${w}`);
                if (name === 'wide') { // zoom, in the box
                    const z = await ev(`(() => { const f = document.querySelector('.artifact-viewer .image-pane-frame'), im = f.querySelector('img'), box = () => { const r = f.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)].join('x'); }, lvl = () => document.querySelector('.artifact-viewer .image-zoom-level').textContent, out = {}; out.box0 = box();
                        out.fit0 = im.clientWidth / im.naturalWidth; f.focus(); f.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })); out.plus = lvl(); f.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })); out.plus2 = lvl();
                        f.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); out.moved = im.style.transform;
                        out.box1 = box(); f.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })); out.minus = lvl(); f.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })); out.fit = lvl(); out.fitT = im.style.transform;
                        const r = f.getBoundingClientRect(), cx = r.left + r.width / 4, cy = r.top + r.height / 2; // the wheel zooms around the pointer: the point under it stays under it
                        const before = im.getBoundingClientRect(), fx = (cx - before.left) / before.width; f.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: cx, clientY: cy, bubbles: true, cancelable: true })); const after = im.getBoundingClientRect(); out.wheelK = lvl(); out.anchor = Math.abs((after.left + fx * after.width) - cx) < 2;
                        f.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
                        return out; })()`).catch(e => ({ err: String(e) }));
                    check(z && !z.err && z.plus === pct(z.fit0, 1.25) && z.plus2 === pct(z.fit0, 1.5625) && z.minus === pct(z.fit0, 1.25) && z.fit === pct(z.fit0, 1) && /scale\(1\)/.test(z.fitT), at + 'the keys zoom and fit: ' + JSON.stringify(z));
                    check(z && /translate\(-?\d+/.test(z.moved) && z.moved !== 'translate(0px, 0px) scale(1.5625)', at + 'an arrow key moves the zoomed picture: ' + (z && z.moved));
                    check(z && z.box0 === z.box1, at + `zooming leaves the box its size: ${z && z.box0} / ${z && z.box1}`);
                    check(z && z.anchor, at + 'the wheel zooms around the pointer');
                    const p = await ev(`(() => { const f = document.querySelector('.artifact-viewer .image-pane-frame'), r = f.getBoundingClientRect(), lvl = () => document.querySelector('.artifact-viewer .image-zoom-level').textContent, cx = r.left + r.width / 2, cy = r.top + r.height / 2, ev = (type, id, x, y) => f.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, bubbles: true, isPrimary: id === 1 }));
                        f.setPointerCapture = () => {}; ev('pointerdown', 1, cx - 50, cy); ev('pointerdown', 2, cx + 50, cy); ev('pointermove', 1, cx - 100, cy); ev('pointermove', 2, cx + 100, cy); const out = lvl(); ev('pointerup', 1, cx - 100, cy); ev('pointerup', 2, cx + 100, cy); return out; })()`);
                    check(p === pct(z.fit0, 2), at + 'a pinch (two fingers spreading to twice the distance) doubles the scale: ' + p + ' / ' + pct(z.fit0, 2));
                    await ev(`document.querySelector('.artifact-viewer .image-zoom-controls button:last-child').click(); true`);
                }
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
            }
        }
        // the same box in the side file preview and in a Before/After pair (#11711): the pane's own panes, drawn into a box shaped like the preview body and into a two-picture row
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const m = await ev(`(async () => { const { renderImagePanes } = await import(${S} + 'utils.js'), sizes = ${JSON.stringify(SIZES)};
                const draw = n => { const [cw, ch] = sizes[n], c = document.createElement('canvas'); c.width = cw; c.height = ch; const g = c.getContext('2d'); g.fillStyle = '#3a6ea5'; g.fillRect(0, 0, cw, ch); return c.toDataURL('image/png'); };
                const out = {}; const mount = (cls, width, height) => { const box = document.createElement('div'); box.className = cls; box.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;display:flex;flex-direction:column;background:#111;width:' + width + 'px;height:' + height + 'px'; document.body.append(box); return box; };
                const settle = box => new Promise(r => { const t = setInterval(() => { const ims = [...box.querySelectorAll('img')]; if (ims.every(i => i.complete && i.naturalWidth)) { clearInterval(t); setTimeout(r, 120); } }, 40); });
                const geo = (box, k) => { const f = box.querySelectorAll('.image-pane-frame')[k], im = f.querySelector('img'), fr = f.getBoundingClientRect(), ir = im.getBoundingClientRect(), b = box.getBoundingClientRect(); return { boxW: b.width, boxH: b.height, frameW: fr.width, frameH: fr.height, imgW: ir.width, imgH: ir.height, natW: im.naturalWidth, centred: Math.abs((ir.left + ir.width / 2) - (fr.left + fr.width / 2)) < 2 && Math.abs((ir.top + ir.height / 2) - (fr.top + 18 + fr.height / 2)) < 2 }; };
                for (const n of ['wide', 'tall', 'small']) { const box = mount('preview-body', 700, 560); renderImagePanes(box, [{ url: draw(n) }]); await settle(box); out['preview-' + n] = geo(box, 0); box.remove(); }
                for (const n of ['wide', 'small']) { const box = mount('inbox-detail-pane', 460, 900); box.style.height = 'auto'; box.style.display = 'block'; renderImagePanes(box, [{ url: draw(n) }]); await settle(box); const g = geo(box, 0); out['detail-' + n] = { ...g, frameVh: innerHeight }; box.remove(); } // an artifact opened in the Inbox's detail pane or a goal's list has no box of its own around the preview
                const row = mount('preview-body', 700, 600); renderImagePanes(row, [{ label: 'Before', url: draw('wide') }, { label: 'After', url: draw('wide') }]); await settle(row); out.compare = geo(row, 0); out.compareVh = innerHeight; row.remove();
                return out; })()`);
            for (const n of ['wide', 'tall', 'small']) {
                const g = m['preview-' + n], at = `${w} px, side preview, ${n}: `;
                check(g.frameW >= g.boxW * 0.95 && g.frameH >= g.boxH * 0.85, at + `the box fills the preview body (all but its caption): ${JSON.stringify(g)}`);
                check(g.centred, at + 'the picture is in the middle of the box');
                if (n === 'wide') check(g.imgW >= g.frameW * 0.95, at + `a wide picture fits the box's width: ${Math.round(g.imgW)} of ${Math.round(g.frameW)}`);
                if (n === 'small') check(g.imgW <= g.natW + 1, at + `a small picture is not blown up: ${Math.round(g.imgW)} of ${g.natW}`);
            }
            for (const n of ['wide', 'small']) {
                const g = m['detail-' + n], at = `${w} px, detail pane, ${n}: `;
                check(g.frameH >= Math.min(g.frameVh * 0.6, 480) * 0.95 && g.frameW >= g.boxW * 0.9, at + `the picture has a box of its own, not a strip as high as the file: ${JSON.stringify(g)}`);
                check(g.centred, at + 'the picture is in the middle of the box');
                if (n === 'wide') check(g.imgW >= g.frameW * 0.9, at + `a wide picture fits the box's width: ${Math.round(g.imgW)} of ${Math.round(g.frameW)}`);
                if (n === 'small') check(g.imgW <= g.natW + 1, at + `a small picture is not blown up: ${Math.round(g.imgW)} of ${g.natW}`);
            }
            const c = m.compare;
            check(c.frameW >= c.boxW / 2 * 0.85 && c.frameH >= c.boxH * 0.8, `${w} px, Before/After: each box is half the row wide and fills the pane's height (all but the caption), not as high as the picture: ${JSON.stringify(c)}`);
            check(c.imgW >= c.frameW * 0.9 && c.centred, `${w} px, Before/After: the wide picture fits its box's width and sits in the middle: ${JSON.stringify(c)}`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('image_viewer_box_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
