// Walk 81 item 12 (#17818): comparing two versions of an HTML file offers "Before / after": both versions drawn as pages in inert frames, beside the Changes and Side by side views (a Markdown file has no such view).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H2, H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

const HTML = { [H2]: '<h1>Plan</h1><p id="p">Ship on Friday.</p>', [H3]: '<h1>Plan</h1><p id="p">Ship on Monday.</p><script>window.x=1</script>' };
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);
        await ev(`(() => { const inner = window.fetch, H = ${JSON.stringify(HTML)}; window.fetch = (u, o) => { const url = String(u); let m = /\\/api\\/artifacts\\/([0-9a-f]{64})\\/versions/.exec(url); if (m) return inner(u, o).then(r => r.json()).then(rows => new Response(JSON.stringify(rows.map(x => ({ ...x, name: 'plan.html' }))), { headers: { 'Content-Type': 'application/json' } })); m = /\\/api\\/artifacts\\/([0-9a-f]{64})(\\?v=\\d+)?$/.exec(url); if (m && H[m[1]]) return Promise.resolve(new Response(H[m[1]], { headers: { 'Content-Type': 'text/html' } })); return inner(u, o); }; return true; })()`);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(H3)}, { filename: 'plan.html' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .av-compare')`, 'Compare');
        await ev(`document.querySelector('#artifact-viewer .av-compare').click(); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .av-view-page')`, 'the Before / after view');
        await ev(`document.querySelector('#artifact-viewer .av-view-page').click(); true`);
        await waitFor(`document.querySelectorAll('#artifact-viewer iframe.av-page-frame').length === 2`, 'two page frames');
        const frames = await ev(`[...document.querySelectorAll('#artifact-viewer iframe.av-page-frame')].map(f => ({ sandbox: f.getAttribute('sandbox'), doc: f.srcdoc }))`);
        assert.deepEqual(frames.map(f => f.sandbox), ['', ''], 'both frames are inert (empty sandbox)');
        assert.match(frames[0].doc, /Ship on Friday/, 'the left page is the earlier version');
        assert.match(frames[1].doc, /Ship on Monday/, 'the right page is this version');
        assert.equal(await ev(`document.querySelector('#artifact-viewer .av-view-page').getAttribute('aria-pressed')`), 'true');
        console.log('artifact_versions_html: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
