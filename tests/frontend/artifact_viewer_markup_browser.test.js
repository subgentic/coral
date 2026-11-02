// Mark up in the file viewer (#12367, the operator: "I don't see any way to markup the image in the window. But I can markup the image I attach to the comment."): a picture opened in the viewer has Mark up (a button beside
// Comments on a computer, an item of the ⋯ menu on a phone); it opens the comment composer's drawing tool on the file's own image; Done starts a comment on the whole file with the marked copy in its tray and the text box ready
// (the panel, a phone's sheet, opens on it); Cancel changes nothing; the file itself is never changed. A text file has no Mark up. Real drawing (mouse, touch) at 1280 and 390 px; the comments API stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');
const HEX = 'd'.repeat(64), TXT = 'c'.repeat(64);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => {
        const real = window.fetch; window.__up = []; window.__posts = []; window.__cs = []; window.__next = 1; window.__n = 0; window.__slow = false; window.__fail = false; window.__release = null; window.__origReads = 0; window.__changes = [];
        const png = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0));
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const can = c => ({ reply: false, edit: true, delete: true, resolve: true });
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comment-images')) {
                const ct = o && o.headers && o.headers['Content-Type'];
                window.__up.push({ method, url, ct, size: o && o.body && o.body.size });
                if (window.__fail) return json({ error: 'That picture is too large.' }, 413);
                const hex = 'e'.repeat(63) + (++window.__n).toString(16);
                const done = () => json({ hex, name: 'picture-' + window.__n + '.png', content_type: ct, size: (o.body && o.body.size) || 0 }, 201);
                if (window.__slow) return new Promise(res => { window.__release = () => res(done()); });
                return done();
            }
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                if (method === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, mine: true, can: can(c) })), locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true }, limits: { body: 8192, quote: 2048, comments: 500 } });
                if (method === 'POST') { const b = JSON.parse(o.body); window.__posts.push(b); const c = { id: window.__next++, parent_id: null, anchor: b.anchor, body: b.body, images: (b.images || []).map((h, i) => ({ hex: h, name: 'picture-' + (i + 1) + '.png', content_type: 'image/png' })), author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }; window.__cs.push(c); return json({ ...c, can: can(c) }, 201); }
            }
            if (url.includes('/api/artifacts/${HEX}/versions')) return json([]);
            if (url.includes('/api/artifacts/${HEX}')) { window.__origReads++; return Promise.resolve(new Response(new Blob([window.__pic], { type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } })); }
            return real(u, o);
        };
        window.__file = (name, type) => new File([png], name, { type });
        window.__dt = files => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); return dt; };
        return true; })()`;
    const zlib = require('node:zlib');
    const png = (() => { const w = 240, h = 140, raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3, inside = x >= 40 && x < 200 && y >= 30 && y < 110; raw[o] = inside ? 255 : 45; raw[o + 1] = inside ? 255 : 106; raw[o + 2] = inside ? 255 : 79; } }
        const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
        const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
        const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
        return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); })();
    await client.Fetch.enable({ patterns: [{ urlPattern: `*/api/artifacts/${HEX}*`, resourceType: 'Image' }] });
    safePaused(client, async e => { await client.Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: png.toString('base64') }); });
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
            await ev(STUB);
            await ev(`(async () => { const c = Object.assign(document.createElement('canvas'), { width: 240, height: 140 }), x = c.getContext('2d'); x.fillStyle = '#2d6a4f'; x.fillRect(0, 0, 240, 140); x.fillStyle = '#fff'; x.fillRect(40, 30, 160, 80); window.__pic = await new Promise(r => c.toBlob(r, 'image/png')); return true; })()`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'screenshot.png', mediaType: 'image/png' }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .image-panes img')`, at + 'the picture', 8000);
            const markBtn = mobile ? `document.querySelector('#artifact-viewer .artifact-viewer-markup-item')` : `document.querySelector('#artifact-viewer .artifact-viewer-markup')`;
            if (mobile) await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); true`);
            await waitFor(`!!${markBtn} && ${markBtn}.getClientRects().length > 0`, at + (mobile ? 'Mark up is in the ⋯ menu' : 'Mark up is a button in the header'), 6000);
            if (mobile) assert.ok(await ev(`${markBtn}.getBoundingClientRect().height >= 43.5`), at + 'a 44 px target');
            else assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-markup-item').getClientRects().length`), 0, at + 'a computer has the button, not the menu item too');
            await shot('viewer-markup-button-' + w);
            const dlg = `document.querySelector('dialog.markup-dialog')`;
            const drag = async (a, b) => {
                if (mobile) { const t = (type, p) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }] }); await t('touchStart', a); for (let k = 1; k <= 5; k++) await t('touchMove', { x: a.x + (b.x - a.x) * k / 5, y: a.y + (b.y - a.y) * k / 5 }); await t('touchEnd', b); }
                else { const m = (type, p, buttons) => client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 }); await m('mousePressed', a, 1); for (let k = 1; k <= 5; k++) await m('mouseMoved', { x: a.x + (b.x - a.x) * k / 5, y: a.y + (b.y - a.y) * k / 5 }, 1); await m('mouseReleased', b, 0); }
            };
            const open = async () => { await ev(`${markBtn}.click(); true`); await waitFor(`!!${dlg} && ${dlg}.open && !!document.querySelector('.markup-canvas')`, at + 'the editor opens on the picture', 8000); };
            // Cancel: nothing changes
            await open(); await ev(`[...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Cancel').click(); true`); await waitFor(`!${dlg}`, at + 'Cancel closes it', 5000);
            assert.deepEqual([await ev(`window.__up.length`), await ev(`!!document.querySelector('.ac-input')`)], [0, false], at + 'Cancel uploads nothing and starts no comment');
            // Done with a stroke
            if (mobile) await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); true`);
            await open();
            const r = await ev(`(() => { const r = document.querySelector('.markup-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
            await drag({ x: r.x + r.w * 0.2, y: r.y + r.h * 0.3 }, { x: r.x + r.w * 0.7, y: r.y + r.h * 0.7 });
            await ev(`[...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Done').click(); true`); await waitFor(`!${dlg}`, at + 'Done closes it', 5000);
            await waitFor(`!!document.querySelector('.ac-input') && document.querySelectorAll('.ac-thumb').length === 1`, at + 'the comment box is open with the marked copy in its tray', 8000);
            await waitFor(`window.__up.length === 1`, at + 'the marked copy is stored', 6000);
            const st = await ev(`({ focus: document.activeElement === document.querySelector('.ac-input'), anchor: !!document.querySelector('.ac-composer'), up: window.__up.map(u => u.ct), orig: window.__origReads, sheet: !!document.querySelector('.ac-panel.ac-sheet-open') || !${mobile} })`);
            assert.ok(st.focus && st.sheet && st.up.length === 1 && /^image\/png/.test(st.up[0]), at + 'the text box is ready and the marked picture was stored as a picture: ' + JSON.stringify(st));
            await ev(framesJs(25)); await shot('viewer-markup-comment-' + w); // the sheet has slid in
            // Send: a comment on the whole file naming the picture
            await ev(`(() => { const t = document.querySelector('.ac-input'); t.value = 'See the arrow'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 1`, at + 'the comment is sent', 6000);
            const posted = await ev(`window.__posts[0]`);
            assert.ok(posted.anchor && posted.anchor.whole === true && posted.images && posted.images.length === 1 && posted.body === 'See the arrow', at + 'a comment on the whole file with the picture: ' + JSON.stringify(posted));
            assert.ok(await ev(`!window.__posts.some(p => !p.body) && window.__up.every(u => u.method === 'POST')`), at + 'only the comment and its picture were written: the file is not changed');
            // a text file has no Mark up
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(TXT)}, { filename: 'notes.txt', mediaType: 'text/plain' }); return true; })()`); await ev(framesJs(10));
            assert.ok(await ev(`[...document.querySelectorAll('#artifact-viewer .artifact-viewer-markup, #artifact-viewer .artifact-viewer-markup-item')].every(b => b.hidden)`), at + 'a text file has no Mark up');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        }
    } finally { await client.close(); }
    console.log('artifact_viewer_markup_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
