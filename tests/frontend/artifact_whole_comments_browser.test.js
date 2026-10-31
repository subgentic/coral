// Comments on ANY artifact (#11444), against the REAL isolated server: the viewer's comment panel is there for HTML (in its sandboxed frame), a picture, a PDF, a table (CSV), code, plain text, a video and
// a download (a zip), at 1280 and at 390 px, with "Comment on the whole document", threads, Resolve and Lock as for Markdown. The artifacts are written into the server's data folder as an upload leaves
// them; a whole-document comment is made through the panel's own button, and the server's list says it is whole. The panel sits BESIDE the document, never inside it, the frame keeps its sandbox, and a
// document that is not text offers no "Add comment" by a selection. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const DATA = process.env.CORAL_TEST_DATA_DIR || '';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const KINDS = [
    { name: 'report.html', mediaType: 'text/html', bytes: Buffer.from('<!doctype html><title>Report</title><h1>Quarterly report</h1><p>Revenue is up.</p><script>window.parent.__pwned = 1</script>'), html: true },
    { name: 'shot.png', mediaType: 'image/png', bytes: PNG },
    { name: 'spec.pdf', mediaType: 'application/pdf', bytes: PDF },
    { name: 'data.csv', mediaType: 'text/csv', bytes: Buffer.from('name,qty\nwidget,4\ngadget,9\n') },
    { name: 'main.go', mediaType: 'text/x-go', bytes: Buffer.from('package main\n\nfunc main() { println("hi") }\n') },
    { name: 'notes.txt', mediaType: 'text/plain', bytes: Buffer.from('Plain notes.\nSecond line.\n') },
    { name: 'clip.mp4', mediaType: 'video/mp4', bytes: Buffer.from('not really a video, but the viewer opens it as one') },
    { name: 'bundle.zip', mediaType: 'application/zip', bytes: Buffer.from('PK\u0003\u0004 a zip, as far as the viewer can tell') },
].map(k => ({ ...k, hex: crypto.createHash('sha256').update(k.bytes).digest('hex') }));
const WIDTHS = [{ label: '1280', width: 1280, height: 800, mobile: false }, { label: '390', width: 390, height: 844, mobile: true }];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const list = async (hex) => (await api('GET', `/api/artifacts/${hex}/comments?state=all`)).body;
    try {
        assert.ok(DATA, 'run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)');
        const dir = path.join(DATA, 'artifacts', 'objects');
        fs.mkdirSync(dir, { recursive: true });
        for (const k of KINDS) {
            fs.writeFileSync(path.join(dir, k.hex), k.bytes);
            fs.writeFileSync(path.join(dir, k.hex + '.json'), JSON.stringify({ name: k.name, media_type: k.mediaType, size: k.bytes.length, digest: k.hex }));
        }
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        let wi = -1; // the second width sees the first width's comment too (a comment write counts against the author's 20 a minute, so none is deleted in between)
        for (const w of WIDTHS) {
            wi++;
            await Emulation.setDeviceMetricsOverride({ width: w.width, height: w.height, deviceScaleFactor: 1, mobile: w.mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            for (const k of KINDS) {
                const tag = `${w.label} ${k.name}`;
                await ev(`import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer('${k.hex}', { filename: ${JSON.stringify(k.name)}, mediaType: ${JSON.stringify(k.mediaType)} })); true`);
                // the panel loads its threads, so the toggle is there once the comments are known
                await waitFor(`(() => { const t = document.querySelector('.ac-toggle'); return !!t && !t.hidden; })()`, `${tag}: the Comments button`, 10000);
                check(`${tag}: the Comments button is offered`, await ev(`!document.querySelector('.ac-toggle').hidden`));
                await ev(`(() => { const p = document.querySelector('.ac-panel'); if (!p.classList.contains('ac-sheet-open')) document.querySelector('.ac-toggle').click(); return true; })()`);
                await waitFor(`!!document.querySelector('.ac-panel .ac-whole')`, `${tag}: Comment on the whole document`, 6000);
                check(`${tag}: the panel offers "Comment on the whole document"`, await ev(`document.querySelector('.ac-panel .ac-whole').textContent.trim() === 'Comment on the whole document'`));
                check(`${tag}: no comment can be made by selecting text unless it is text`, await ev(`(() => { const b = document.querySelector('.ac-selbtn'); return !b || b.hidden; })()`));
                check(`${tag}: the panel is beside the document, never inside it`, await ev(`(() => { const p = document.querySelector('.ac-panel'), body = document.querySelector('.artifact-viewer-body'); return !body.contains(p) && !p.closest('iframe') && p.closest('.artifact-viewer-main') !== null; })()`));
                if (k.html) {
                    check(`${tag}: the HTML stays in its sandboxed frame (no allow-same-origin, script cannot reach the page)`, await ev(`(() => { const f = document.querySelector('.artifact-viewer-body iframe'); return !!f && f.hasAttribute('sandbox') && !/allow-same-origin/.test(f.getAttribute('sandbox')) && !window.__pwned; })()`));
                }
                // a whole-document comment, through the panel
                await ev(`document.querySelector('.ac-panel .ac-whole').click(); true`);
                await waitFor(`!!document.querySelector('.ac-panel .ac-input')`, `${tag}: the composer`, 4000);
                await ev(`(() => { const ta = document.querySelector('.ac-panel .ac-input'); ta.value = ${JSON.stringify('Looks right: ' + tag)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.closest('form').requestSubmit(); return true; })()`);
                await waitFor(`document.querySelectorAll('.ac-panel .ac-card').length === ${wi + 1}`, `${tag}: the new card`, 6000);
                const d = await list(k.hex);
                check(`${tag}: the server holds one whole-document comment with that text`, d && d.comments.length === wi + 1 && d.comments.every(c => c.anchor && c.anchor.whole === true) && d.comments.some(c => c.body === 'Looks right: ' + tag), JSON.stringify(d && d.comments && d.comments.map(c => c.anchor)));
                check(`${tag}: the card says it is on the whole document`, await ev(`[...document.querySelectorAll('.ac-panel .ac-card .ac-quote')].every(q => /The whole document/.test(q.textContent))`));
                check(`${tag}: Resolve and Reply are there, and Lock for the owner`, await ev(`(() => { const t = document.querySelector('.ac-panel').textContent; return /Resolve/.test(t) && /Reply/.test(t) && !!document.querySelector('.ac-panel .ac-lock'); })()`));
                // clean up: the artifact's comments go with it, and the viewer closes
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
            }
        }
        // a text anchor on a picture is still refused by the server, with the reason (the viewer never sends one)
        const refused = await api('POST', `/api/artifacts/${KINDS[1].hex}/comments`, { body: 'x', anchor: { quote: 'y', prefix: '', suffix: '' } });
        check('a comment pointing into text is refused for a picture, with the reason', refused.status === 415 && /whole document/.test(refused.body.error), JSON.stringify(refused.body));
    } catch (e) {
        console.error(e && e.stack || e);
        results.push(false);
    } finally {
        for (const k of KINDS) { try { await api('DELETE', `/api/artifacts/${k.hex}`); } catch (_) {} }
        await guard.restore().catch(() => {}); try { await client.close(); } catch (_) {}
    }
    const failed = results.filter(r => !r).length;
    console.log(failed ? `${failed} FAILED` : `PASS comments on any artifact: ${results.length} checks`);
    process.exitCode = failed ? 1 : 0;
})();
