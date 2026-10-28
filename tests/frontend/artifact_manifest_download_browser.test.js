// An artifact's Download saves the file, not a .json (#9925, the Operator): a manifest is a JSON list of files, and its viewer's Download (and the preview pane's) saved that list, so a PNG sent as a one-file
// manifest came out as a .json. One file: Download saves that file under its own name; several: the manifest's header has no Download (each row has its own, and the toolbar's Download JSON is the manifest);
// and the viewer, reused for the next artifact, does not keep the last one's link or hidden Download. The store is stubbed through fetch (an upload needs an agent session).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;
const ONE = 'a'.repeat(64), MANY = 'b'.repeat(64), PNG = 'c'.repeat(64), TXT = 'd'.repeat(64), SECOND = 'e'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => {
            const real = window.fetch;
            const manifest = list => JSON.stringify(list.map(([name, hex, media_type]) => ({ name, uri: 'coral://artifacts/' + hex, media_type })));
            window.fetch = (input, init) => {
                const u = String(input && input.url ? input.url : input);
                const json = body => Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="shots.json"' } }));
                if (u.endsWith('/api/artifacts/${ONE}?v=2') && window.__held) return new Promise(res => { window.__release = () => res(json(manifest([['screenshot.png', '${PNG}', 'image/png']]))); });
                if (u.endsWith('/api/artifacts/${ONE}?v=2')) return json(manifest([['screenshot.png', '${PNG}', 'image/png']]));
                if (u.endsWith('/api/artifacts/${MANY}?v=2')) return json(manifest([['screenshot.png', '${PNG}', 'image/png'], ['notes.txt', '${SECOND}', 'text/plain']]));
                if (u.endsWith('/api/artifacts/${TXT}?v=2')) return Promise.resolve(new Response('plain notes', { headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'inline; filename="notes.txt"' } }));
                return real(input, init);
            };
            return true;
        })()`);
        const dl = () => ev(`(() => { const a = document.querySelector('.artifact-viewer-download'); return { href: a.getAttribute('href'), name: a.getAttribute('download'), hidden: a.hidden || a.getClientRects().length === 0 }; })()`);
        const open = async (hex, name, ready) => { await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer('${hex}', { filename: ${JSON.stringify(name)} })).then(() => true)`); await waitFor(ready, 'the viewer rendered ' + name, 10000); };

        // until the manifest is fetched and parsed nobody knows it is one: the Download has no address then, so an early click cannot save the .json (#9941)
        await ev(`window.__held = true; import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer('${ONE}', { filename: 'shots.json' })); true`);
        await waitFor(`!!window.__release`, 'the manifest fetch is held', 8000);
        let held = await ev(`(() => { const a = document.querySelector('.artifact-viewer-download'); return { href: a.getAttribute('href'), disabled: a.getAttribute('aria-disabled') }; })()`);
        assert.deepEqual([held.href, held.disabled], [null, 'true'], 'while the manifest is on its way the Download has no address and says so ' + JSON.stringify(held));
        await ev(`window.__held = false; window.__release(); true`);
        await waitFor(`/Artifact manifest/.test(document.querySelector('.artifact-viewer-title').textContent)`, 'the manifest rendered', 10000);
        held = await ev(`(() => { const a = document.querySelector('.artifact-viewer-download'); return { href: a.getAttribute('href'), disabled: a.getAttribute('aria-disabled'), name: a.getAttribute('download') }; })()`);
        assert.deepEqual([held.href, held.disabled, held.name], [`/api/artifacts/${PNG}?v=2`, null, 'screenshot.png'], 'then the file by its name, enabled ' + JSON.stringify(held));
        // one file: the file
        await open(ONE, 'shots.json', `/Artifact manifest/.test(document.querySelector('.artifact-viewer-title').textContent)`);
        let d = await dl();
        assert.deepEqual([d.href, d.name, d.hidden], [`/api/artifacts/${PNG}?v=2`, 'screenshot.png', false], 'a one-file manifest: Download saves the PNG by its own name, not the .json ' + JSON.stringify(d));
        // several files: no Download in the header
        await open(MANY, 'shots.json', `/Artifact manifest/.test(document.querySelector('.artifact-viewer-title').textContent) && document.querySelectorAll('.artifact-manifest-entry').length === 2`);
        d = await dl();
        assert.equal(d.hidden, true, 'a manifest of several files has no header Download (each row has one) ' + JSON.stringify(d));
        // the viewer, reused for a plain file: its own Download is back, not the last manifest's
        await open(TXT, 'notes.txt', `document.querySelector('.artifact-viewer-title').textContent === 'notes.txt'`);
        d = await dl();
        assert.deepEqual([d.href, d.name, d.hidden], [`/api/artifacts/${TXT}?v=2`, '', false], 'a plain file after a manifest: its own Download, shown ' + JSON.stringify(d));
        console.log('PASS Download saves the file: a one-file manifest gives its file, several give none, a reused viewer keeps nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
