// The View source button on an HTML artifact: clicking it shows the HTML source as code with line-anchored comments, and the back link restores the rendered preview with whole-document comments.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HEX = 'cd'.repeat(32);
const HTML_CONTENT = '<h1>Hello</h1><p>World</p>';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
            if (url.includes('/api/artifacts/${HEX}') && !/versions|comments/.test(url)) return Promise.resolve(new Response(${JSON.stringify(HTML_CONTENT)}, { status: 200, headers: { 'Content-Type': 'text/html' } }));
            if (/\\/api\\/artifacts\\/${HEX}\\/(versions|comments)/.test(url)) return Promise.resolve(new Response(JSON.stringify(/comments/.test(url) ? { comments: [], locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} } : []), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return orig(u, o); }; return true; })()`);

        await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${HEX}', { filename: 'page.html', mediaType: 'text/html' })).then(() => true)`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`, 'rendered preview', 10000);

        // 1. The View source button is on the notice bar
        const hasBtn = await ev(`!!document.querySelector('#artifact-viewer .artifact-html-source-btn')`);
        assert.ok(hasBtn, 'View source button is present on the HTML preview');

        // 2. Click View source: the preview is replaced by code text and a back link
        await ev(`document.querySelector('#artifact-viewer .artifact-html-source-btn').click(); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body .artifact-html-back')`, 'back link', 5000);
        const sourceState = await ev(`(() => {
            const body = document.querySelector('#artifact-viewer .artifact-viewer-body');
            return {
                hasBack: !!body.querySelector('.artifact-html-back'),
                hasCode: !!body.querySelector('.preview-pane-code'),
                hasIframe: !!body.querySelector('.artifact-linked-preview iframe'),
                codeText: (body.querySelector('.preview-pane-code code') || {}).textContent || ''
            };
        })()`);
        assert.ok(sourceState.hasBack, 'back link is present in source view');
        assert.ok(sourceState.hasCode, 'source code is rendered');
        assert.ok(!sourceState.hasIframe, 'iframe is gone in source view');
        assert.ok(sourceState.codeText.includes('<h1>Hello</h1>'), 'source shows the HTML content');

        // 3. Click back: the rendered preview is restored
        await ev(`document.querySelector('#artifact-viewer .artifact-html-back').click(); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`, 'restored preview', 10000);
        const restored = await ev(`(() => {
            const body = document.querySelector('#artifact-viewer .artifact-viewer-body');
            return {
                hasIframe: !!body.querySelector('.artifact-linked-preview iframe'),
                hasCode: !!body.querySelector('.preview-pane-code'),
                hasSourceBtn: !!body.querySelector('.artifact-html-source-btn')
            };
        })()`);
        assert.ok(restored.hasIframe, 'iframe is back in rendered view');
        assert.ok(!restored.hasCode, 'code view is gone');
        assert.ok(restored.hasSourceBtn, 'View source button is re-added');

        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
    } finally { await client.close(); }
    console.log('artifact_html_source_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
