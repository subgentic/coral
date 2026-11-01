// Pictures in an artifact comment against the REAL isolated server (#11650 + #11651): the page's picker, thumbnail and Send meeting the real upload route, the store and the list. The commented document
// is written into the server's data folder as an agent's upload leaves it (its object, its sidecar and its session's upload record, so the file has a team); a picture is added through the real file input, a
// picture alone is sent as a comment, and what the server kept is read back through its API and its database: the stored type, the images on the comment, the picture drawn in the thread from the raw URL
// (and again after a reload), the refusals of the route (a declared type that disagrees with the bytes, text sent as a picture, a type that is not one of the three). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { sqliteText } = require('./helpers/sqlite.js');

const DOC = ['# Phone layout', '', 'The list is drawn in two columns on a wide screen.', ''].join('\n');
const HEX = crypto.createHash('sha256').update(DOC).digest('hex');
const SESSION = 'walksess1';
const TEAM = 'walk-team';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA = process.env.CORAL_TEST_DATA_DIR || '';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings(); // the install's owner id (a setting) is made the first time a comment is written, and put back at the end
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    // a raw upload to the real route from the page's own origin: the bytes as base64, the declared type as sent
    const rawUpload = (b64, type, query) => ev(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)); const r = await fetch('/api/artifacts/${HEX}/comment-images${query || ''}', { method: 'POST', headers: { 'Content-Type': ${JSON.stringify(type)} }, body: bytes }); return { status: r.status, body: await r.json().catch(() => ({})) }; })()`);
    try {
        assert.ok(DATA, 'run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)');
        const objects = path.join(DATA, 'artifacts', 'objects');
        fs.mkdirSync(objects, { recursive: true });
        fs.writeFileSync(path.join(objects, HEX), DOC);
        fs.writeFileSync(path.join(objects, HEX + '.json'), JSON.stringify({ name: 'layout.md', media_type: 'text/markdown', size: Buffer.byteLength(DOC), digest: HEX }));
        const uploads = path.join(DATA, 'artifacts', 'uploads', SESSION);
        fs.mkdirSync(uploads, { recursive: true });
        fs.writeFileSync(path.join(uploads, HEX + '.json'), JSON.stringify({ name: 'layout.md', media_type: 'text/markdown', size: Buffer.byteLength(DOC), digest: 'sha256:' + HEX, created_at: new Date().toISOString(), board: TEAM, uploader: 'Dev' }));
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const open = async () => {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer('${HEX}', { filename: 'layout.md', mediaType: 'text/markdown' }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
            await waitFor(`!document.querySelector('.ac-toggle').hidden`, 'the Comments button', 5000);
            if (!(await ev(`document.querySelector('.ac-panel').getClientRects().length > 0`))) { await ev(`document.querySelector('.ac-toggle').click(); true`); }
            await waitFor(`!!document.querySelector('.ac-whole') || !!document.querySelector('.ac-card')`, 'the panel', 8000);
        };
        await open();
        await ev(`document.querySelector('.ac-whole').click(); true`);
        await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, 'the composer', 5000);

        // a picture through the page's own file input, to the real route: stored, then a comment that is a picture alone
        await ev(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' })); const i = document.querySelector('.ac-composer .ac-picker input'); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`);
        await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-img').length === 1 && document.querySelectorAll('.ac-composer .ac-thumb-uploading').length === 0`, 'the stored thumbnail', 8000);
        check('the real route took the picture: no failed thumbnail', (await ev(`document.querySelectorAll('.ac-composer .ac-thumb-failed').length`)) === 0);
        await ev(`document.querySelector('.ac-composer').requestSubmit(); true`);
        await waitFor(`document.querySelectorAll('.ac-card .ac-pic-img').length === 1`, 'the picture in the thread', 8000);
        await waitFor(`[...document.querySelectorAll('.ac-card .ac-pic-img')].every(i => i.complete && i.naturalWidth > 0)`, 'the picture drawn from the artifact URL of a team artifact', 8000);
        const d = (await api('GET', `/api/artifacts/${HEX}/comments?state=all`)).body;
        const c = d.comments[0];
        check('the comment is on the server with one picture and no words', d.comments.length === 1 && c.body === '' && c.images && c.images.length === 1 && c.images[0].content_type === 'image/png' && /^[0-9a-f]{64}$/.test(c.images[0].hex), JSON.stringify(c && c.images));
        const pic = c.images[0].hex;
        const raw = await ev(`fetch('/api/artifacts/${pic}?v=2').then(async r => ({ status: r.status, type: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength }))`);
        check('the picture is served from its artifact URL (?v=2) as a PNG', raw.status === 200 && /image\/png/.test(raw.type) && raw.n > 0, JSON.stringify(raw));
        check('it is kept with the document\'s team (its upload record in that session\'s folder, as a comment picture)', fs.existsSync(path.join(uploads, pic + '.json')) && JSON.parse(fs.readFileSync(path.join(uploads, pic + '.json'), 'utf8')).source === 'comment-image');
        check('the database holds the picture with the comment', sqliteText(path.join(DATA, 'sessions.db'), `select images_json from artifact_comments where artifact_id = '${HEX}'`).includes(pic));

        // the refusals of the real route: the bytes decide, never the declared type
        const mism = await rawUpload(PNG, 'image/jpeg');
        check('a PNG sent as a JPEG is refused: image_type_mismatch', mism.status === 415 && mism.body.code === 'image_type_mismatch', JSON.stringify(mism));
        const text = await rawUpload(Buffer.from('this is not a picture').toString('base64'), 'image/png');
        check('text sent as a PNG is refused: image_type', text.status === 415 && text.body.code === 'image_type', JSON.stringify(text));
        const gif = await rawUpload(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1').toString('base64'), 'image/gif');
        check('a GIF is not one of the three: image_type', gif.status === 415 && gif.body.code === 'image_type', JSON.stringify(gif));
        const notYours = await ev(`fetch('/api/artifacts/${HEX}/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'x', images: ['${'ab'.repeat(32)}'], anchor: { whole: true } }) }).then(async r => ({ status: r.status }))`);
        check('a comment naming a picture nobody uploaded for it is refused', notYours.status === 400, JSON.stringify(notYours));

        // after a reload the picture is still in the thread, drawn
        await open();
        await waitFor(`document.querySelectorAll('.ac-card .ac-pic-img').length === 1`, 'the picture after a reload', 8000);
        await waitFor(`[...document.querySelectorAll('.ac-card .ac-pic-img')].every(i => i.complete && i.naturalWidth > 0)`, 'the picture drawn after a reload', 8000);
        check('after a reload the picture is in the thread and drawn', true);
        console.log(results.every(Boolean) ? 'PASS comment pictures against the real route' : 'FAIL comment pictures against the real route');
        if (!results.every(Boolean)) process.exitCode = 1;
    } finally { await guard.restore(); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
