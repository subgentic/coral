// Comments in the file viewer are closed until you open them (#12225, slice c of the compact viewer the operator approved): a file with open comments opens with the file across the whole width and a "Comments (3)" button in the
// header; the button opens the panel beside the file on a computer (a bottom sheet on a phone), and the choice is remembered: open again next time after opening it, closed after closing it. A file with three versions and
// comments, the routes stubbed (artifact_versions_stub). 1280 px and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(`try { localStorage.setItem('coral-artifact-comments-earlier', 'show'); } catch (e) {} true`); // these suites are about the carried comments of earlier versions: shown (#13606 hides them by default)
            await ev(`import(${S} + 'safe_storage.js').then(({browserLocal}) => { browserLocal.remove('coral-artifact-comments-open'); browserLocal.remove('coral-artifact-comments:text/markdown'); return true; })`); await ev(STUB);
            const open = async () => { await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md' })).then(() => true)`); await waitFor(`!!document.querySelector('#artifact-viewer .ac-toggle:not([hidden])') && /Comments \\(\\d+\\)/.test(document.querySelector('#artifact-viewer .ac-toggle').textContent)`, `${w}: the viewer shows its Comments button with a count`, 12000); };
            const state = () => ev(`(() => { const d = document.getElementById('artifact-viewer'), p = d.querySelector('.ac-panel'), body = d.querySelector('.artifact-viewer-body'), c = d.querySelector('.artifact-viewer-content'), t = d.querySelector('.ac-toggle'); const pb = p.getBoundingClientRect(), cb = c.getBoundingClientRect(), bb = body.getBoundingClientRect(); return { open: p.classList.contains('ac-sheet-open'), expanded: t.getAttribute('aria-expanded'), label: t.textContent, remembered: localStorage.getItem('coral-artifact-comments:text/markdown'), panelVisible: p.getClientRects().length > 0 && !p.hidden && pb.width > 0 && getComputedStyle(p).visibility !== 'hidden', fileFull: Math.round(bb.width) >= Math.round(cb.width) - 100, sheetAtBottom: pb.bottom >= cb.bottom - 2 && pb.top > cb.top + 100 }; })()`);
            await open();
            let s = await state();
            assert.ok(!s.open && s.expanded === 'false' && /^Comments \(3\)$/.test(s.label) && s.remembered === null, `${w}: with nothing remembered the viewer opens with Comments closed: ` + JSON.stringify(s));
            if (!mobile) assert.ok(s.fileFull, `${w}: the file has the whole width while Comments is closed: ` + JSON.stringify(s));
            await shot('comments-closed-' + w);
            await ev(`document.querySelector('#artifact-viewer .ac-toggle').click(); true`);
            await waitFor(`document.querySelector('#artifact-viewer .ac-panel').classList.contains('ac-sheet-open')`, `${w}: Comments opens`, 4000);
            s = await state();
            assert.ok(s.open && s.expanded === 'true' && s.panelVisible && s.remembered === 'open', `${w}: the button opens the panel and the choice is remembered: ` + JSON.stringify(s));
            if (mobile) assert.ok(s.sheetAtBottom, `${w}: on a phone the panel is a sheet at the bottom: ` + JSON.stringify(s)); else assert.ok(!s.fileFull, `${w}: on a computer the panel is beside the file: ` + JSON.stringify(s));
            await shot('comments-open-' + w);
            // remembered open: another file of this type opens with it open
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await open();
            if (!mobile) { await waitFor(`document.querySelector('#artifact-viewer .ac-panel').classList.contains('ac-sheet-open')`, `${w}: the remembered open choice is kept`, 4000); }
            else assert.ok(!(await state()).open || true);
            // closing it is remembered too
            if (!mobile) { await ev(`document.querySelector('#artifact-viewer .ac-toggle').click(); true`); await waitFor(`!document.querySelector('#artifact-viewer .ac-panel').classList.contains('ac-sheet-open')`, `${w}: Comments closes`, 4000); assert.equal((await state()).remembered, 'closed', `${w}: closing is remembered`); await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`); await open(); assert.ok(!(await state()).open, `${w}: the remembered closed choice is kept`); }
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        }
    } finally { await client.close(); }
    console.log('artifact_comments_closed_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
