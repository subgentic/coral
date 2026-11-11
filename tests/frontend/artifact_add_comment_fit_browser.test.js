// #15231 (walk 8 M3 and walk 11 M3, #15164 M11): the "Add comment" button that follows a selection is whole and inside the dialog (it was cut at the right edge), and it does not cover the selected text. 1024 x 700 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1024, 700, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(H3)}, { filename: 'release-plan.md' }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body') && document.querySelector('#artifact-viewer .artifact-viewer-body').textContent.length > 20`, at + 'the file shows', 12000);
            const sel = () => {
                const body = document.querySelector('#artifact-viewer .artifact-viewer-body'), p = [...body.querySelectorAll('p, li')].find(e => e.textContent.trim().length > 30) || body;
                const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let last = null; while (walker.nextNode()) last = walker.currentNode;
                const r = document.createRange(); r.setStart(last, Math.max(0, last.length - 12)); r.setEnd(last, last.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
            };
            await ev(`(${sel.toString()})()`);
            await waitFor(`(() => { const b = document.querySelector('.ac-selbtn'); return !!b && !b.hidden; })()`, at + 'the Add comment button follows the selection', 8000).catch(() => {});
            const m = await ev(`(() => { const b = document.querySelector('.ac-selbtn'), d = document.querySelector('#artifact-viewer .artifact-viewer-content'), r = getSelection().rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : null, br = b.getBoundingClientRect(), dr = d.getBoundingClientRect();
                return { shown: !b.hidden, b: [Math.round(br.left), Math.round(br.top), Math.round(br.right), Math.round(br.bottom)], d: [Math.round(dr.left), Math.round(dr.top), Math.round(dr.right), Math.round(dr.bottom)], sel: r && [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], vw: innerWidth }; })()`);
            assert.ok(m.shown, at + 'the button shows for a selection: ' + JSON.stringify(m));
            assert.ok(m.b[0] >= m.d[0] && m.b[2] <= m.d[2] && m.b[2] <= m.vw && m.b[1] >= m.d[1] && m.b[3] <= m.d[3], at + 'the whole button is inside the dialog: ' + JSON.stringify(m));
            const over = !(m.b[2] <= m.sel[0] || m.b[0] >= m.sel[2] || m.b[3] <= m.sel[1] || m.b[1] >= m.sel[3]);
            assert.ok(!over, at + 'it does not cover the selected text: ' + JSON.stringify(m));
            console.log(at + JSON.stringify(m));
            // the comment is on the selected words, whatever the panel opening does to the line breaks (walk 8 M6)
            const picked = await ev(`getSelection().rangeCount ? getSelection().getRangeAt(0).toString() : ''`);
            await ev(`document.querySelector('.ac-selbtn').click(); true`);
            await waitFor(`!!document.querySelector('#artifact-viewer .ac-composer .ac-quote')`, at + 'the comment box opens with its quote', 5000);
            const quoted = await ev(`document.querySelector('#artifact-viewer .ac-composer .ac-quote').textContent`);
            assert.equal(quoted.replace(/\s+/g, ' ').trim(), picked.replace(/\s+/g, ' ').trim(), at + 'the quote is the selected words: ' + JSON.stringify({ picked, quoted }));
        }
    } finally { await client.close(); }
    console.log('artifact_add_comment_fit_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
