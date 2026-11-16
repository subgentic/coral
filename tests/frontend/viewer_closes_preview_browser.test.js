// #16737 follow-up (#17631): opening the full artifact viewer closes the preview pane's
// tab for the same artifact, so the file does not show in two places at once.
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
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);
        await ev(`window.__m.add('coral-go', 'm', 6, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input')`, 'the agent is selected', 10000);

        // open the artifact in the preview pane as a tab
        await ev(`import(${S} + 'preview_pane.js').then(m => { m.openArtifactTab('coral://artifacts/${H3}', { filename: 'release-plan.md', board: 'team-a' }); return true; })`);
        await waitFor(`document.querySelectorAll('#preview-tabs .preview-tab').length > 0`, 'the preview tab exists', 5000);
        const before = await ev(`document.querySelectorAll('#preview-tabs .preview-tab').length`);
        assert.ok(before >= 1, 'the artifact has a preview tab before the viewer opens: ' + before);

        // open the same artifact in the full viewer
        await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
        await waitFor(`!document.querySelector('#artifact-viewer').hidden`, 'the full viewer is open', 8000);

        // the preview tab for that artifact should be gone
        const after = await ev(`document.querySelectorAll('#preview-tabs .preview-tab').length`);
        assert.equal(after, 0, 'the preview tab closed when the full viewer opened: ' + after);

        // close the viewer
        await ev(`document.querySelector('.artifact-viewer-close').click(); true`);

        console.log('PASS viewer closes the preview tab for the same artifact (#16737, #17631)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
