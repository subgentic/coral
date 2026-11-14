// #16737: openLatest does not show the caller's stale version line, the preview pane
// exports closeArtifactTab for the full viewer, and the ⋯ menu has a Full screen item on a phone.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H1, H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);

        // 1. closeArtifactTab is exported by the preview pane module.
        const hasExport = await ev(`import(${S} + 'preview_pane.js').then(m => typeof m.closeArtifactTab === 'function')`);
        assert.ok(hasExport, 'preview_pane exports closeArtifactTab');

        // 2. openLatest: the caller's stale version line is not shown before the bar loads.
        await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer('${H1}', { openLatest: true, filename: 'release-plan.md', fileId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', versionLine: 'version 1 of release-plan.md (file a1b2c3d4e5f60718293a4b5c6d7e8f90)', board: 'team-a' })).then(() => true)`);
        await waitFor(`!document.querySelector('#artifact-viewer').hidden`, 'the full viewer is open for openLatest', 8000);
        const line = await ev(`document.querySelector('.artifact-viewer-versionline')?.textContent || ''`);
        assert.ok(!line.includes('version 1'), 'the stale "version 1" line is not shown when openLatest is set: got ' + JSON.stringify(line));
        await waitFor(`/version 3/.test(document.querySelector('.artifact-viewer-title')?.textContent || '')`, 'the bar resolves to the newest version', 12000);
        const barLine = await ev(`document.querySelector('.artifact-viewer-versionline')?.textContent || ''`);
        assert.ok(barLine.includes('version 3'), 'the bar sets the correct version line for v3: got ' + JSON.stringify(barLine));
        await ev(`document.querySelector('.artifact-viewer-close').click(); true`);

        // 3. A phone has the Full screen menu item (the button is hidden).
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);
        await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
        await waitFor(`!document.querySelector('#artifact-viewer').hidden`, 'the phone viewer is open', 8000);
        await ev(framesJs(4));
        const phoneBtn = await ev(`document.querySelector('#artifact-viewer .artifact-viewer-fullscreen').getClientRects().length`);
        assert.equal(phoneBtn, 0, 'the standalone fullscreen button is hidden on a phone');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); true`);
        await waitFor(`!document.querySelector('#artifact-viewer .artifact-viewer-menu').hidden`, 'the phone menu opens', 4000);
        const fsItem = await ev(`(() => { const e = document.querySelector('#artifact-viewer .artifact-viewer-fullscreen-item'); return e && e.getClientRects().length > 0 ? e.textContent.trim() : null; })()`);
        assert.equal(fsItem, 'Full screen', 'the Full screen menu item is visible on a phone');
        await ev(`document.querySelector('.artifact-viewer-close').click(); true`);

        console.log('PASS viewer fixes: openLatest skips stale line, closeArtifactTab exported, phone Full screen menu item');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
