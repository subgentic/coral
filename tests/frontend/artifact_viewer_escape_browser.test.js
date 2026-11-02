// Escape with the focus on the page while the file viewer is open (#12290, the operator's "a Needs you row will not open" bug, reproduced 5 of 5 by Beta Tester on v2.0.33): the viewer closes and the page stays where it was
// (Needs you), instead of jumping to /agents; and afterwards a row still opens the viewer. Escape with the focus inside the viewer works already. The Escape is dispatched on body, as a key pressed with the focus on the page's own text.
// 1280 and 390 px; the file routes stubbed (artifact_versions_stub).
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
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`/\\/inbox/.test(location.pathname)`, `${w}: on the Inbox`, 8000);
            const where = await ev(`location.pathname`);
            const open = () => ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
            for (let round = 1; round <= 2; round++) {
                await open();
                await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') && !!document.querySelector('.artifact-viewer-body').textContent.includes('Release plan')`, `${w}: round ${round}: the viewer opens` + (round === 2 ? ' again after the first Escape' : ''), 8000);
                await ev(`document.querySelector('.artifact-viewer-body').click(); document.activeElement && document.activeElement.blur(); document.body.focus(); true`); // the focus on the page's own text, not in the viewer
                await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); true`);
                await waitFor(`!document.querySelector('.artifact-viewer') || document.querySelector('.artifact-viewer').hidden`, `${w}: round ${round}: Escape on the page closes the viewer`, 4000).catch(async e => { throw new Error(e.message + ' STATE ' + await ev(`JSON.stringify({ path: location.pathname, hidden: document.querySelector('.artifact-viewer') && document.querySelector('.artifact-viewer').hidden, open: !!document.querySelector('.artifact-viewer:not([hidden])') })`)); });
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: a route change would land within a frame or two
                const after = await ev(`location.pathname`);
                assert.equal(after, where, `${w}: round ${round}: Escape closes the viewer and the page stays where it was (it went to ${after}, from ${where})`);
            }
        }
    } finally { await client.close(); }
    console.log('artifact_viewer_escape_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
