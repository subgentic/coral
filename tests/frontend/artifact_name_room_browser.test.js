// #15217 (walk 5 L16/L17): a file name is cut with an ellipsis while there is room to spare. The viewer's title and the Artifacts table use the room they have: a name that fits is shown whole, at desktop and phone width.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const HEX = 'ab'.repeat(32), NAME = 'quarterly-planning-notes-for-the-whole-team.md'; // 47 characters
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => String(u).includes('/api/artifacts/${HEX}') && !String(u).includes('/comments') && !String(u).includes('/versions') ? Promise.resolve(new Response('# notes', { status: 200, headers: { 'Content-Type': 'text/markdown' } })) : real(u, o); return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => { v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: ${JSON.stringify(NAME)}, mediaType: 'text/markdown', server: 'local' }); return true; })`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-title-name')`, `${w}: the viewer opens`, 8000);
            const m = await ev(`(() => { const n = document.querySelector('#artifact-viewer .artifact-viewer-title-name'), t = document.querySelector('#artifact-viewer .artifact-viewer-title'); const r = n.getBoundingClientRect(), tr = t.getBoundingClientRect(); return { cut: n.scrollWidth > n.clientWidth + 1, name: Math.round(n.clientWidth), scroll: Math.round(n.scrollWidth), title: Math.round(tr.width), dialog: Math.round(document.querySelector('#artifact-viewer').getBoundingClientRect().width) }; })()`);
            console.log(w, JSON.stringify(m));
            if (m.cut && m.dialog - m.name > 200) failures.push(`${w}: the name is cut (${m.name} of ${m.scroll} px) with ${m.dialog - m.name} px of the dialog to spare`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a name that fits is shown whole');
})().catch(e => { console.error(e); process.exit(1); });
