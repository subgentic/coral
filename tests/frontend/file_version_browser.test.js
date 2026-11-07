// A file's stable id and version line in the viewer (#14145, #14178): the header and Details say the line of the version SHOWN, a version switch and a save-style reopen replace it (a v2 is never labelled v3), Copy file ID copies the id
// alone and reports failure when there is no clipboard or the copy is refused, and a file with no valid id shows nothing. Stubbed server (artifact_versions_stub: three versions, each row with its own line). 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H1, H2, H3, STUB, FILE, lineOf } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    const head = () => ev(`(document.querySelector('#artifact-viewer .artifact-viewer-versionline') || {}).textContent || ''`);
    const headShown = () => ev(vis('#artifact-viewer .artifact-viewer-versionline'));
    const chip = () => ev(`(document.querySelector('#artifact-viewer .artifact-viewer-fileid:not([hidden]) .artifact-viewer-fileid-text') || {}).textContent || ''`);
    const open = (hex, extra) => ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(hex)}, Object.assign({ filename: 'release-plan.md' }, ${JSON.stringify(extra)})); return true; })()`);
    const closeViewer = () => ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
    const openDetails = async () => { await waitFor(vis('#artifact-viewer .artifact-viewer-details'), 'Details', 6000); await ev(`(() => { const b = document.querySelector('#artifact-viewer .artifact-viewer-details'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`); };
    const toast = () => ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);
    const copyClick = () => ev(`[...document.querySelectorAll('#artifact-viewer .artifact-viewer-fileid button')].find(b => b.textContent === 'Copy file ID').click(); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(STUB);

            console.log(`${at}: v3 opened with its line: the header and Details say it`);
            await open(H3, { fileId: FILE, versionLine: lineOf(3) });
            await waitFor(vis('#artifact-viewer .av-current'), `${at}: the bar`, 6000);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(lineOf(3))}`, `${at}: the header line of v3`, 6000);
            assert.equal(await headShown(), true, `${at}: the header line is visible`);
            await openDetails();
            assert.equal(await chip(), lineOf(3), `${at}: Details says it too`);

            console.log(`${at}: choosing v2 replaces the line: a v2 is never labelled v3`);
            await ev(`document.querySelector('#artifact-viewer .av-current').click(); true`);
            await waitFor(vis('#artifact-viewer .av-list'), `${at}: the list`, 3000);
            await ev(`document.querySelector('#artifact-viewer .av-option[data-version="2"]').click(); true`);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-body').textContent.includes('Revoke sits beside Rename')`, `${at}: v2's text`, 6000);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(lineOf(2))}`, `${at}: the header line of v2`, 4000);
            assert.equal(await head(), lineOf(2), `${at}: the header says v2`);
            assert.equal(await chip(), lineOf(2), `${at}: Details says v2, not v3`);
            assert.ok(!(await head()).includes('version 3'));

            console.log(`${at}: a save-style reopen (the previous version's opts spread onto the new hex) takes the new version's line`);
            await open(H1, { fileId: FILE, versionLine: lineOf(3), switched: false }); // what onSaved and a discarded edit do: the caller's line is v3's, the hex shown is v1
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(lineOf(1))}`, `${at}: v1's own line, not the v3 line the opts carried`, 6000);
            assert.equal(await chip(), lineOf(1));
            await closeViewer();

            console.log(`${at}: Copy file ID copies the id alone; no clipboard and a refused copy are failures`);
            await open(H3, { fileId: FILE, versionLine: lineOf(3) });
            await openDetails();
            await ev(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); true`);
            await copyClick();
            await waitFor(`window.__copied.length === 1`, `${at}: copied`, 3000);
            assert.deepEqual(await ev(`window.__copied`), [FILE], `${at}: the id alone`);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('File ID copied'))`, `${at}: the success toast`, 3000);
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('refused')) }, configurable: true }); true`);
            await copyClick();
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('could not be copied'))`, `${at}: a refused copy says so`, 3000);
            assert.ok(!(await toast()).includes('File ID copied'), `${at}: and does not say it was copied`);
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); true`);
            await copyClick();
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('could not be copied'))`, `${at}: no clipboard is a failed copy`, 3000);
            assert.ok(!(await toast()).includes('File ID copied'), `${at}: not "copied" when there is no clipboard`);
            await closeViewer();

            console.log(`${at}: a line never outlives its open: no metadata on a reopen, another team's row, a close`);
            await ev(STUB);
            const X = '8'.repeat(64); // a hex the stub lists no versions for: only the caller's opts could give it a line
            const L_A = `version 2 of notes.md (file ${FILE})`, FILE_B = 'b1b2b3b4b5b6b7b8b9babbbcbdbebf00', L_B = `version 5 of notes.md (file ${FILE_B})`;
            await open(X, { fileId: FILE, versionLine: L_A, board: 'team-a', server: undefined });
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(L_A)}`, `${at}: team A's row says its line`, 6000);
            await closeViewer();
            await open(X, { board: 'team-a' }); // the same digest again from a caller with no metadata (an older server, a plain link)
            await waitFor(`!!document.getElementById('artifact-viewer') && !document.getElementById('artifact-viewer').hidden && !!document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent`, `${at}: reopened`, 6000);
            assert.equal(await headShown(), false, `${at}: a reopen with no metadata shows no line (it must not reuse the first open's)`);
            assert.equal(await chip(), '', `${at}: and no Copy chip`);
            await closeViewer();
            await open(X, { fileId: FILE, versionLine: L_A, board: 'team-a' });
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(L_A)}`, `${at}: A again`, 6000);
            await open(X, { fileId: FILE_B, versionLine: L_B, board: 'team-b' }); // the same digest from another team, with that team's own id and line
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(L_B)}`, `${at}: team B's own line replaces A's`, 6000);
            assert.equal(await chip(), L_B, `${at}: Details says B's too, never A's`);
            await open(X, { board: 'team-b' }); // and without metadata from team B: none, not B's, not A's
            await waitFor(`!document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent`, `${at}: cleared`, 6000);
            await closeViewer();

            console.log(`${at}: a file with no id, or a made-up one, shows no line`);
            await ev(STUB);
            for (const extra of [{}, { fileId: 'not-an-id', versionLine: 'version 9 of x (file not-an-id)' }, { fileId: FILE }, { fileId: FILE, versionLine: lineOf(3), lineHex: H3 }]) { // the last: a line given for v3 and carried onto a hex with no versions list (what a switch or a save spreads)
                // an unknown hex has no versions list: nothing but the caller's opts could give it a line
                await open('9'.repeat(64), extra);
                await waitFor(`!!document.getElementById('artifact-viewer') && !document.getElementById('artifact-viewer').hidden`, `${at}: the viewer opens`, 6000);
                await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent`, `${at}: drawn`, 6000);
                assert.equal(await headShown(), false, `${at}: no header line for ${JSON.stringify(extra)}`);
                assert.equal(await chip(), '', `${at}: no chip for ${JSON.stringify(extra)}`);
                await closeViewer();
            }
        }
        console.log('file_version_browser: ok');
    } finally { try { client.close(); } catch { /* closed */ } }
})().catch(e => { console.error(e); process.exit(1); });
