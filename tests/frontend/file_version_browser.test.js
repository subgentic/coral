// A file's stable id and version line in the viewer's Details (#14145): the one line the server tells ("version N of <name> (file <id>)") with a Copy file ID button that copies only the id. A row with no file id shows nothing.
// Stubbed server (artifact_versions_stub). 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

const FILE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LINE = `version 3 of release-plan.md (file ${FILE})`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    const open = (extra) => ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(H3)}, Object.assign({ filename: 'release-plan.md' }, ${JSON.stringify(extra)})); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(STUB);
            await ev(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); true`);

            console.log(`${at}: Details shows the version line and Copy file ID copies the id alone`);
            await open({ fileId: FILE, versionLine: LINE });
            await waitFor(vis('#artifact-viewer .artifact-viewer-details'), `${at}: the Details button`, 6000);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-details').click(); true`);
            await waitFor(vis('#artifact-viewer .artifact-viewer-fileid'), `${at}: the version line`, 4000);
            assert.equal((await ev(`document.querySelector('#artifact-viewer .artifact-viewer-fileid').firstChild.textContent`)).trim(), LINE);
            await ev(`[...document.querySelectorAll('#artifact-viewer .artifact-viewer-fileid button')].find(b => b.textContent === 'Copy file ID').click(); true`);
            await waitFor(`window.__copied.length === 1`, `${at}: the id was copied`, 3000);
            assert.deepEqual(await ev(`window.__copied`), [FILE], `${at}: only the id, not the line`);

            console.log(`${at}: a file with no id shows no line, and a made-up id shows none either`);
            for (const extra of [{}, { fileId: 'not-an-id', versionLine: 'version 9 of x (file not-an-id)' }, { fileId: FILE }]) {
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
                await open(extra);
                await waitFor(`!document.getElementById('artifact-viewer').hidden`, `${at}: the viewer opens`, 6000);
                await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent`, `${at}: its text is drawn`, 6000); // the line, if there were one, is added with the header's chips, before the body
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-details')?.click(); true`);
                assert.equal(await ev(`!!document.querySelector('#artifact-viewer .artifact-viewer-fileid')`), false, `${at}: no line for ${JSON.stringify(extra)}`);
            }
        }
        console.log('file_version_browser: ok');
    } finally { try { client.close(); } catch { /* closed */ } }
})().catch(e => { console.error(e); process.exit(1); });
