// A text artifact's inline preview (the Artifacts list, a goal's Artifacts) wraps a long line without the viewer ever having been opened (#15267, UI/UX's MUST): the preview loads the sheet that holds the wrap rule.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.equal(await ev(`!!document.querySelector('link[href*="artifact_viewer_header"]')`), false, 'the viewer has not been opened: its sheet is not loaded');
        await ev(`(() => { const h = document.createElement('div'); h.id = 'qa-host'; h.style.width = '300px'; document.body.append(h); return true; })()`);
        await ev(`import(${S} + 'artifact_item.js').then(m => { m.renderText(document.getElementById('qa-host'), 'x'.repeat(400) + ' ' + 'y'.repeat(400), 'notes.txt'); return true; })`);
        await waitFor(`getComputedStyle(document.querySelector('#qa-host pre')).whiteSpace === 'pre-wrap'`, 'the preview <pre> wraps (white-space: pre-wrap)', 6000);
        assert.ok(await ev(`document.querySelector('#qa-host pre').scrollWidth <= document.querySelector('#qa-host').clientWidth + 1`), 'a long line does not run past the preview');
        console.log('PASS a text preview wraps a long line without the viewer being opened');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
