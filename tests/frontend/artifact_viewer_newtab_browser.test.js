// #10312 (Claude Desktop pass 28): opening what an agent shares. The viewer of an artifact has Open in new tab beside Download (a link to the stored bytes, its own tab, no opener), and a picture opens taller:
// a pasted screenshot of a hundred pixels is not a strip at the top of a dialog. At 1400x900 and a 390x844 phone. The bytes come from a stubbed fetch and the <img>'s request (the server's artifact store
// needs an agent session to upload; board_auto_attach_e2e covers that side).
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { safePaused } = require('./helpers/paused');
const CDP = require('chrome-remote-interface');

const BASE = require('./test_base').BASE;
const IMG_HEX = 'd'.repeat(64);
const MD_HEX = 'e'.repeat(64);

// A small PNG, w x h, one colour: made here so the picture's own size is known.
function png(w, h) {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(120, 80);

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation, Fetch } = client;
    const ev = async expression => {
        const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const { coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic||'/static/')`;
    const waitFor = async (expr, what, ms = 6000) => { const until = Date.now() + ms; for (;;) { if (await ev(expr)) return; if (Date.now() > until) throw new Error('timed out waiting for ' + what); await new Promise(r => setTimeout(r, 25)); } };
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Fetch.enable({ patterns: [{ urlPattern: `*/api/artifacts/${IMG_HEX}*` }] });
        safePaused(client, p => Fetch.fulfillRequest({ requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG.toString('base64') }).catch(() => {}));
        for (const [w, h, mobile] of [[1400, 900, false], [390, 844, true]]) {
            const tag = mobile ? 'phone' : 'desktop';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired();
            await coralReady();
            await ev(`(() => { const real = window.fetch; const png = Uint8Array.from(atob(${JSON.stringify(PNG.toString('base64'))}), c => c.charCodeAt(0));
                window.fetch = (input, init) => { const u = String(input && input.url ? input.url : input);
                    if (u.endsWith('/api/artifacts/${IMG_HEX}?v=2')) return Promise.resolve(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
                    if (u.endsWith('/api/artifacts/${MD_HEX}?v=2')) return Promise.resolve(new Response('# hello', { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }));
                    return real(input, init); };
                return true; })()`);

            console.log(`${tag}: a picture opens taller and the viewer can open it in a new tab`);
            await ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(IMG_HEX)}, { filename: 'screen.png', mediaType: 'image/png' }))`);
            await waitFor(`(() => { const i = document.querySelector('#artifact-viewer .image-pane-frame img'); return !!i && i.complete && i.naturalWidth > 0; })()`, 'the picture');
            await waitFor(`document.getElementById('artifact-viewer').classList.contains('is-image')`, 'the viewer to know it holds a picture');
            const v = await ev(`(() => { const d = document.getElementById('artifact-viewer'), n = d.querySelector('.artifact-viewer-newtab'), dl = d.querySelector('.artifact-viewer-download'), b = d.querySelector('.artifact-viewer-body').getBoundingClientRect(), r = n.getBoundingClientRect();
                return { text: n.textContent.trim(), hidden: n.hidden, shown: r.width > 0 && r.height > 0, href: n.getAttribute('href'), dl: dl.getAttribute('href'), target: n.target, rel: n.rel, bodyH: b.height, vh: innerHeight, touch: r.height }; })()`);
            assert.equal(v.text, 'Open in new tab', `${tag}: the link says what it does`);
            assert.ok(v.shown && !v.hidden, `${tag}: the link is on screen: ${JSON.stringify(v)}`);
            assert.equal(v.href, v.dl, `${tag}: it opens the stored bytes, the same as Download's`);
            assert.equal(v.target, '_blank', `${tag}: in a tab of its own`);
            assert.equal(v.rel, 'noopener noreferrer', `${tag}: with no opener`);
            assert.ok(v.bodyH >= Math.min(0.5 * v.vh, 400), `${tag}: a 120x80 picture does not open as a strip: the body is ${v.bodyH}px of ${v.vh}`);
            if (mobile) assert.ok(v.touch >= 44, `${tag}: a 44 px target: ${v.touch}`);

            console.log(`${tag}: a text artifact has the link too, and is not made taller`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click()`);
            await ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(MD_HEX)}, { filename: 'notes.md', mediaType: 'text/markdown' }))`);
            await waitFor(`(() => { const n = document.querySelector('#artifact-viewer .artifact-viewer-newtab'); return !n.hidden && !!n.getAttribute('href') && /hello/.test(document.querySelector('#artifact-viewer .artifact-viewer-body').textContent); })()`, 'the text artifact and its link');
            assert.ok(!(await ev(`document.getElementById('artifact-viewer').classList.contains('is-image')`)), `${tag}: only a picture is made taller`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click()`);
        }
        console.log('\nAll artifact-viewer new-tab checks passed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
