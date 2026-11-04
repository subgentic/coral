// #13179 (the operator on the demo: 'it's quite flattened'): the artifact viewer, the dialog a file opens in for review, sized itself to its content, so a three-line note was a short wide box with the
// Comments column squeezed. On a computer the dialog now has a steady height (most of the window) whatever the document's length, and a long document scrolls inside it. At 1440x900 a short and a long
// note are the same height, at least 80% of the window; the phone keeps its own sizing (not asserted here: artifact_viewer_phone_browser owns it). The bytes come from a stubbed fetch.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const SHORT = 'c'.repeat(64), LONG = 'd'.repeat(64);
const SHORT_DOC = '# Review note\n\nThree short lines.\nNothing else.\n';
const LONG_DOC = '# Long note\n\n' + Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of a long note.`).join('\n\n') + '\n';

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic||'/static/')`;
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired();
        await coralReady();
        await ev(`(() => { const docs = { [${JSON.stringify(SHORT)}]: ${JSON.stringify(SHORT_DOC)}, [${JSON.stringify(LONG)}]: ${JSON.stringify(LONG_DOC)} }; const real = window.fetch;
            window.fetch = (input, init) => { const u = String(input && input.url ? input.url : input); for (const h of Object.keys(docs)) if (u.includes('/api/artifacts/' + h)) return Promise.resolve(new Response(docs[h], { headers: { 'Content-Type': 'text/markdown' } })); return real(input, init); }; return true; })()`);
        const heights = {};
        for (const [name, hex] of [['short', SHORT], ['long', LONG]]) {
            await ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(hex)}, { filename: ${JSON.stringify(name + '-note.md')}, mediaType: 'text/markdown' }))`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body') && document.querySelector('#artifact-viewer .artifact-viewer-body').textContent.includes(${JSON.stringify(name === 'short' ? 'Three short lines' : 'Line 200')})`, `the ${name} note`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog's layout settles once the text is in
            heights[name] = await ev(`(() => { const c = document.querySelector('#artifact-viewer .artifact-viewer-content').getBoundingClientRect(), b = document.querySelector('#artifact-viewer .artifact-viewer-body'); return { h: Math.round(c.height), vh: innerHeight, bodyScrolls: b.scrollHeight > b.clientHeight + 1 }; })()`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click()`);
        }
        assert.ok(heights.short.h >= heights.short.vh * 0.8, `a short note's dialog is at least 80% of the window: ${JSON.stringify(heights)}`);
        assert.ok(Math.abs(heights.short.h - heights.long.h) <= 2, `a short and a long note open at the same height: ${JSON.stringify(heights)}`);
        assert.ok(heights.long.bodyScrolls && !heights.short.bodyScrolls, `the long note scrolls inside the dialog and the short one does not: ${JSON.stringify(heights)}`);
        console.log('PASS artifact viewer: a steady height on a computer, short note or long');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
