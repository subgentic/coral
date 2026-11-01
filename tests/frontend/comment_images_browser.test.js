// Pictures in an artifact comment (#11651, goal #184 slice 1, the page): in the comment box a person picks, pastes or drops a picture; each shows as a thumbnail before Send (and goes up as it is added, so Send only names what is
// stored), a text file or a fifth picture is refused with words, a failed one blocks Send until it is removed, Send waits for one still going up; after Send the pictures are inline in the thread, drawn from the artifact's raw URL,
// in the order sent. Against a stub of Backend Dev's route (POST /api/artifacts/{id}/comment-images, raw body, answers {hex, name, content_type, size}; `images` on create and on the list). 1280 px and a 390 px phone, where
// every button is 44 px tall and nothing scrolls sideways. Drives Chrome over CDP through agent_view_harness.js.
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
        // a picture in the thread is an <img>, which the page's fetch stub never sees: the browser's own request for a stored picture is answered here
        const { Fetch } = client;
        safePaused(client, ({ requestId }) => Fetch.fulfillRequest({ requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }));
        await Fetch.enable({ patterns: [{ urlPattern: '*/api/artifacts/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee*' }] });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await load(w, h, mobile);

            // the picker: a button, and a file input that takes the three picture types (a phone offers its photos)
            assert.deepEqual(await ev(`(() => { const b = document.querySelector('.ac-composer .ac-add-image'), i = document.querySelector('.ac-composer .ac-picker input'); return { b: !!b && b.textContent, accept: i && i.accept, multiple: i && i.multiple, hidden: i && i.hidden }; })()`), { b: 'Add image', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true }, at + 'the picker');
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-images').hidden`), true, at + 'no pictures: no tray');

            // pick one: a thumbnail before Send, uploaded as the raw file with its own type
            await pick([['one.png', 'image/png']]);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-img').length === 1`, at + 'the thumbnail', 5000); await settled();
            assert.deepEqual(await ev(`window.__up.map(x => [x.method, x.ct, x.size > 0])`), [['POST', 'image/png', true]], at + 'one upload, raw, with its type');
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-thumb-img').src.startsWith('blob:')`), true, at + 'the thumbnail is the file itself, before Send');
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-thumb-img').naturalWidth > 0`), true, at + 'and it is drawn');

            // paste a picture into the text
            await ev(`(() => { const ta = document.querySelector('.ac-composer .ac-input'); ta.focus(); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: window.__dt([window.__file('pasted.png', 'image/png')]), bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-img').length === 2`, at + 'the pasted picture', 5000); await settled();
            // drop a picture on the form
            await ev(`(() => { const f = document.querySelector('.ac-composer'); f.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__dt([window.__file('dropped.webp', 'image/webp')]), bubbles: true, cancelable: true })); f.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt([window.__file('dropped.webp', 'image/webp')]), bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-img').length === 3`, at + 'the dropped picture', 5000); await settled();
            assert.equal(await ev(`document.querySelector('.ac-composer').classList.contains('ac-drop')`), false, at + 'the drop outline is gone after the drop');

            // a text file is refused with words; the fourth is taken, the fifth is not
            await pick([['notes.txt', 'text/plain']]);
            assert.match(await ev(`document.querySelector('.ac-composer .ac-images-note').textContent`), /Only PNG, JPEG and WebP/, at + 'a text file is refused with words');
            assert.equal(await thumbs(), 3, at + 'and nothing was added');
            await pick([['four.jpeg', 'image/jpeg'], ['five.png', 'image/png']]);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-img').length === 4`, at + 'four', 5000); await settled();
            assert.match(await ev(`document.querySelector('.ac-composer .ac-images-note').textContent`), /at most 4 pictures/, at + 'a fifth is refused with words');
            assert.equal(await ev(`window.__up.length`), 4, at + 'only the four went up');

            // Remove takes a picture out (its name in the button's name)
            assert.match(await ev(`document.querySelector('.ac-composer .ac-thumb-remove').getAttribute('aria-label')`), /^Remove one\.png$/, at + 'Remove names the picture');
            await ev(`document.querySelector('.ac-composer .ac-thumb-remove').click(); true`);
            assert.equal(await thumbs(), 3, at + 'removed');

            // a picture still going up holds Send; a failed one blocks it until it is removed
            await ev(`window.__slow = true; true`);
            await pick([['slow.png', 'image/png']]);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-uploading').length === 1`, at + 'uploading', 5000);
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-send').disabled`), true, at + 'Send waits for the upload');
            await ev(`window.__slow = false; window.__release(); true`);
            await settled();
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-send').disabled`), false, at + 'Send is back when it is stored');
            await ev(`window.__release = null; window.__fail = true; true`);
            await ev(`(() => { document.querySelector('.ac-composer .ac-thumb-remove').click(); return true; })()`); // room for one more
            await pick([['toolarge.png', 'image/png']]);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-failed').length === 1`, at + 'the failed one', 5000);
            assert.match(await ev(`document.querySelector('.ac-composer .ac-thumb-failed .ac-thumb-state').textContent`), /too large/, at + 'it says the server\'s reason');
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-send').disabled`), true, at + 'Send is blocked by a failed picture');
            await ev(`document.querySelector('.ac-composer .ac-thumb-failed .ac-thumb-remove').click(); window.__fail = false; true`);
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-send').disabled`), false, at + 'removed, Send is open again');

            // the layout: a phone's buttons are 44 px, nothing scrolls sideways
            if (mobile) {
                const tiny = await ev(`[...document.querySelectorAll('.ac-composer button')].filter(b => b.getClientRects().length).map(b => [b.textContent, Math.round(b.getBoundingClientRect().height)]).filter(x => x[1] < 44)`);
                assert.deepEqual(tiny, [], at + 'every button of the composer is 44 px tall');
            }
            assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, at + 'nothing scrolls sideways');

            // Send: the post names the stored pictures in order, and the thread shows them inline
            const names = await ev(`window.__up.length`);
            const ready = await ev(`[...document.querySelectorAll('.ac-composer .ac-thumb-img')].length`);
            assert.equal(ready, 3, at + 'three pictures to send');
            await ev(`(() => { const t = document.querySelector('.ac-composer .ac-input'); t.value = 'The lock is the problem, see these'; t.dispatchEvent(new Event('input')); document.querySelector('.ac-composer').requestSubmit(); return true; })()`);
            await waitFor(`window.__posts.length === 1`, at + 'the post', 5000);
            const post = await ev(`window.__posts[0]`);
            assert.equal(post.body, 'The lock is the problem, see these');
            assert.equal(post.images.length, 3, at + 'the post names three pictures');
            assert.ok(post.images.every(h => /^e{63}[0-9a-f]$/.test(h)) && new Set(post.images).size === 3, at + 'each is a stored artifact (' + JSON.stringify(post.images) + ')');
            await waitFor(`document.querySelectorAll('.ac-card .ac-pic-img').length === 3`, at + 'the pictures in the thread', 5000);
            await waitFor(`[...document.querySelectorAll('.ac-card .ac-pic-img')].every(i => i.complete && i.naturalWidth > 0)`, at + 'the pictures drawn', 5000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('.ac-card .ac-pic-img')].map(i => new URL(i.src).pathname)`), post.images.map(h => `/api/artifacts/${h}`), at + 'drawn from the artifacts\' own URLs (?v=2, there is no /raw route), in the order sent');
            assert.equal(await ev(`!!document.querySelector('.ac-composer .ac-thumb')`), false, at + 'the composer is gone with its pictures');
            assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, at + 'the thread does not scroll sideways');
            assert.equal(await ev(`(() => { const i = document.querySelector('.ac-card .ac-pic-img'), p = document.querySelector('.ac-panel'); return i.getBoundingClientRect().right <= p.getBoundingClientRect().right + 1; })()`), true, at + 'a picture stays inside the panel');
            void names;

            // a picture alone is a comment (the Operator's marked-up screenshot); nothing at all is still refused in words
            await ev(`document.querySelector('.ac-whole').click(); true`);
            await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, at + 'the composer again', 5000);
            await ev(`document.querySelector('.ac-composer').requestSubmit(); true`);
            assert.equal(await ev(`document.querySelector('.ac-composer .ac-error').textContent`), 'Write something first.', at + 'no words and no picture: refused in words');
            assert.equal(await ev(`window.__posts.length`), 1, at + 'and nothing was posted');
            await pick([['alone.png', 'image/png']]);
            await waitFor(`document.querySelectorAll('.ac-composer .ac-thumb-img').length === 1`, at + 'the picture', 5000); await settled();
            await ev(`document.querySelector('.ac-composer').requestSubmit(); true`);
            await waitFor(`window.__posts.length === 2`, at + 'the picture-only post', 5000);
            const alone = await ev(`window.__posts[1]`);
            assert.equal(alone.body, '', at + 'the post has no words');
            assert.equal(alone.images.length, 1, at + 'and one picture');
            await waitFor(`document.querySelectorAll('.ac-card .ac-pic-img').length === 4`, at + 'its picture in the thread', 5000);
            assert.equal(await ev(`window.__up.some(x => /board=/.test(x.url))`), false, at + 'opened with no team context the uploads carry no board');
            console.log(`   ✓ ${w} px`);
        }
        // opened from a team, the upload names the team (the route needs it when several teams hold the file)
        await load(1280, 800, false, '@box/team-x');
        await pick([['named.png', 'image/png']]);
        await waitFor(`window.__up.length === 1`, 'the upload', 5000);
        assert.match(await ev(`window.__up[0].url`), /\/comment-images\?board=team-x$/, 'the upload carries the team\'s bare board name');
        console.log('PASS comment pictures: pick, paste and drop, thumbnails before Send, refusals in words, Send waits, inline in the thread');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
