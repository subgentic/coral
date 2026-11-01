// Mark up on a picture of a comment (#11654, Goal #184 slice 2, the wiring): each ready thumbnail has a Mark up button; it opens the markup editor (the real image_markup.js), Done uploads the marked PNG with
// version_of=<the first picture's hex> and the thumbnail becomes the marked copy (still one picture; Send names the new hex); marking again still follows the FIRST hex; Cancel changes nothing; a failed upload keeps the
// original and says why; the button is 44 px tall on a 390 px phone. Against the same stub of Backend Dev's comment-images route as comment_images_browser. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');
const HEX = 'd'.repeat(64);
const MD = ['# Plan', '', 'The backfill takes a write lock on large databases.'].join('\n');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const STUB = `(() => {
        const real = window.fetch; window.__up = []; window.__posts = []; window.__cs = []; window.__next = 1; window.__n = 0; window.__slow = false; window.__fail = false; window.__release = null;
        const png = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0));
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const can = c => ({ reply: false, edit: true, delete: true, resolve: true });
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comment-images')) {
                const ct = o && o.headers && o.headers['Content-Type'];
                window.__up.push({ method, url, ct, size: o && o.body && o.body.size });
                if (window.__fail) return json({ error: 'That picture is too large.' }, 413);
                const hex = 'e'.repeat(63) + (++window.__n).toString(16);
                const done = () => json({ hex, name: 'picture-' + window.__n + '.png', content_type: ct, size: (o.body && o.body.size) || 0 }, 201);
                if (window.__slow) return new Promise(res => { window.__release = () => res(done()); });
                return done();
            }
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                if (method === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, mine: true, can: can(c) })), locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true }, limits: { body: 8192, quote: 2048, comments: 500 } });
                if (method === 'POST') { const b = JSON.parse(o.body); window.__posts.push(b); const c = { id: window.__next++, parent_id: null, anchor: b.anchor, body: b.body, images: (b.images || []).map((h, i) => ({ hex: h, name: 'picture-' + (i + 1) + '.png', content_type: 'image/png' })), author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }; window.__cs.push(c); return json({ ...c, can: can(c) }, 201); }
            }
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o);
        };
        window.__file = (name, type) => new File([png], name, { type });
        window.__dt = files => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); return dt; };
        return true; })()`;
    const load = async (w, h, mobile, team) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
        await ev(STUB);
        if (team) await ev(`import(${S} + 'state.js').then(m => { m.state.selectedTeam = ${JSON.stringify(team)}; return true; })`);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
        await waitFor(`!document.querySelector('.ac-toggle').hidden`, 'the Comments button', 5000);
        if (mobile || !(await ev(`document.querySelector('.ac-panel').getClientRects().length > 0`))) { await ev(`document.querySelector('.ac-toggle').click(); true`); await new Promise(r => setTimeout(r, 400)); } // sleep-ok: the sheet slides in
        await waitFor(`!!document.querySelector('.ac-whole')`, 'the whole-document button', 5000);
        await ev(`document.querySelector('.ac-whole').click(); true`);
        await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, 'the composer', 5000);
    };
    const thumbs = () => ev(`document.querySelectorAll('.ac-composer .ac-thumb').length`);
    const settled = () => waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-uploading').length === 0`, 'the uploads to finish', 5000);
    const pick = (files) => ev(`(() => { const i = document.querySelector('.ac-composer .ac-picker input'); i.files = window.__dt([${files.map(f => `window.__file(${JSON.stringify(f[0])}, ${JSON.stringify(f[1])})`).join(',')}]).files; i.dispatchEvent(new Event('change')); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await load(w, h, mobile);
            const H1 = 'e'.repeat(63) + '1', H2 = 'e'.repeat(63) + '2', H3 = 'e'.repeat(63) + '3';
            // a picture big enough to draw on
            await ev(`(async () => { const c = document.createElement('canvas'); c.width = 400; c.height = 250; const x = c.getContext('2d'); x.fillStyle = '#0000ff'; x.fillRect(0, 0, 400, 250); const b = await new Promise(r => c.toBlob(r, 'image/png')); window.__big = new File([b], 'shot.png', { type: 'image/png' }); const i = document.querySelector('.ac-composer .ac-picker input'); i.files = window.__dt([window.__big]).files; i.dispatchEvent(new Event('change')); return true; })()`);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-img').length === 1`, at + 'the thumbnail', 5000); await settled();
            const markBtn = `document.querySelector('.ac-composer .ac-thumb-markup')`;
            assert.equal(await ev(`${markBtn}.textContent + '|' + ${markBtn}.getAttribute('aria-label')`), 'Mark up|Mark up shot.png', at + 'a ready picture has Mark up, named');
            if (mobile) assert.ok((await ev(`${markBtn}.getBoundingClientRect().height`)) >= 43.5, at + 'a 44 px target');
            const dlg = `document.querySelector('dialog.markup-dialog')`;
            const drag = async (a, b) => {
                if (mobile) {
                    const t = (type, p) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }] });
                    await t('touchStart', a); for (let k = 1; k <= 5; k++) await t('touchMove', { x: a.x + (b.x - a.x) * k / 5, y: a.y + (b.y - a.y) * k / 5 }); await t('touchEnd', b);
                } else {
                    const m = (type, p, buttons) => client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 });
                    await m('mousePressed', a, 1); for (let k = 1; k <= 5; k++) await m('mouseMoved', { x: a.x + (b.x - a.x) * k / 5, y: a.y + (b.y - a.y) * k / 5 }, 1); await m('mouseReleased', b, 0);
                }
            };
            const mark = async () => {
                await ev(`${markBtn}.click(); true`);
                await waitFor(`!!${dlg} && ${dlg}.open`, at + 'the editor opens', 8000);
                const r = await ev(`(() => { const r = document.querySelector('.markup-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
                await drag({ x: r.x + r.w * 0.2, y: r.y + r.h * 0.3 }, { x: r.x + r.w * 0.7, y: r.y + r.h * 0.7 });
                await ev(`[...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Done').click(); true`);
                await waitFor(`!${dlg}`, at + 'the editor closes', 5000);
            };

            // Cancel: nothing changes, nothing uploads
            await ev(`${markBtn}.click(); true`); await waitFor(`!!${dlg} && ${dlg}.open`, at + 'opens', 8000);
            assert.equal(await ev(`(() => { const n = ${dlg}.querySelector('.markup-kept'); return n && n.getClientRects().length > 0 ? n.textContent : null; })()`), 'The original is kept as an earlier version and the team\'s agents can see it. To hide something, remove the original instead.', at + 'the quiet line about the original is shown by Done');
            await ev(`[...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Cancel').click(); true`);
            await waitFor(`!${dlg}`, at + 'closed', 5000);
            assert.equal(await ev(`window.__up.length`), 1, at + 'Cancel uploads nothing');

            // Done: the marked copy goes up as the next version of the first picture, and takes its place
            const before = await ev(`document.querySelector('.ac-composer .ac-thumb-img').src`);
            await mark(); await settled();
            await waitFor(`window.__up.length === 2`, at + 'the marked upload', 5000);
            assert.match(await ev(`window.__up[1].url`), new RegExp(`\\?version_of=${H1}$`), at + 'with version_of the first hex');
            assert.equal(await ev(`window.__up[1].ct`), 'image/png', at + 'a PNG');
            assert.equal(await thumbs(), 1, at + 'still one picture');
            assert.notEqual(await ev(`document.querySelector('.ac-composer .ac-thumb-img').src`), before, at + 'the thumbnail is the marked copy');

            // marking the marked copy still follows the FIRST hex
            await mark(); await settled();
            await waitFor(`window.__up.length === 3`, at + 'the second marking', 5000);
            assert.match(await ev(`window.__up[2].url`), new RegExp(`\\?version_of=${H1}$`), at + 'the series stays the first picture\'s');

            // a failed upload keeps the picture, says why, and Send is not blocked
            await ev(`window.__fail = true; true`);
            await mark();
            await waitFor(`/too large/.test(document.querySelector('.ac-composer .ac-images-note').textContent)`, at + 'the reason is said', 5000);
            assert.equal(await ev(`document.querySelectorAll('.ac-composer .ac-thumb-ready').length`), 1, at + 'the picture is still there and ready');
            await ev(`window.__fail = false; true`);

            // Send names the latest hex, once
            await ev(`document.querySelector('.ac-composer .ac-send').click(); true`);
            await waitFor(`window.__posts.length === 1`, at + 'the comment is sent', 5000);
            assert.deepEqual(await ev(`window.__posts[0].images`), [H3], at + 'it names the marked copy only');
            await waitFor(`document.querySelectorAll('.ac-card .ac-pic-img').length === 1`, at + 'one picture in the thread', 5000);
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS Mark up on a comment picture: next version of the first, replaces the thumbnail, cancel and failure change nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
