// The New goal form's Description and pictures (#11653, the operator's request): a multi-line Description (the goal's outcome field, 2,000 characters, a live count near the limit), pictures picked, pasted or dropped with the comment
// box's tray (stored as they are added, on the goal's team, and named in `images` on create), and no 'Driver: the agent who looks after it' line under the Driver. The goal's page says Description, keeps its line breaks and draws
// its pictures under it (from /api/artifacts/{hex}?v=2: there is no /raw route). Real board and goals on the isolated dev server; the two routes of Backend Dev's #11650 slice (POST /api/board/{team}/goal-images, `images` on create and on the goal) are a stub. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gnd-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const STUB = (goalId) => `(() => {
        const real = window.fetch; window.__up = []; window.__posts = []; window.__n = 0; window.__fail = false;
        const png = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0));
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/board/${B}/goal-images')) {
                const ct = o && o.headers && o.headers['Content-Type'];
                window.__up.push({ method, url, ct, size: o && o.body && o.body.size });
                if (window.__fail) return json({ error: 'That picture is too large.' }, 413);
                const hex = 'e'.repeat(63) + (++window.__n).toString(16);
                return json({ hex, name: 'picture-' + window.__n + '.png', content_type: ct, size: (o.body && o.body.size) || 0 }, 201);
            }
            if (method === 'POST' && /\\/api\\/board\\/${B}\\/goals$/.test(url)) { window.__posts.push(JSON.parse(o.body)); return json({ id: 999, title: 'x', state: 'active', orchestrator_told_at: new Date().toISOString() }, 201); }
            if (method === 'GET' && ${goalId ? 'true' : 'false'} && /\\/api\\/board\\/${B}\\/goals(\\/${goalId})?(\\?|$)/.test(url)) { // the goal as the #11650 slice will give it: with its pictures
                return real(u, o).then(async r => { const j = await r.clone().json().catch(() => null); if (!j) return r; const add = g => (g && g.id === ${goalId} ? { ...g, images: [{ hex: 'e'.repeat(63) + '1', name: 'one.png', content_type: 'image/png' }, { hex: 'e'.repeat(63) + '2', name: 'two.png', content_type: 'image/png' }] } : g);
                    return json(Array.isArray(j) ? j.map(add) : j.goals ? { ...j, goals: j.goals.map(add) } : add(j)); });
            }
            return real(u, o);
        };
        window.__file = (name, type) => new File([png], name, { type });
        window.__dt = files => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); return dt; };
        return true; })()`;
    const load = async (url, w, h, mobile, goalId) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(STUB(goalId));
    };
    const pick = (files) => ev(`(() => { const i = document.querySelector('.goals-dialog .ac-picker input'); i.files = window.__dt([${files.map(f => `window.__file(${JSON.stringify(f[0])}, ${JSON.stringify(f[1])})`).join(',')}]).files; i.dispatchEvent(new Event('change')); return true; })()`);
    const settled = () => waitFor(`document.querySelectorAll('.goals-dialog .ac-thumb-uploading').length === 0`, 'the uploads to finish', 5000);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const { Fetch } = client;
        safePaused(client, ({ requestId }) => Fetch.fulfillRequest({ requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }));
        await Fetch.enable({ patterns: [{ urlPattern: '*/api/artifacts/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee*' }] });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const OUTCOME = 'First line of the description.\nSecond line, after a break.';
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Has a description', outcome: OUTCOME, done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);

        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            // the form
            await load(`/team/${B}/goals`, w, h, mobile, 0);
            await waitFor(`!!document.querySelector('#team-panel-goals .goals-new')`, at + 'the New goal button', 15000);
            await ev(`document.querySelector('#team-panel-goals .goals-new').click(); true`);
            await waitFor(`!!document.querySelector('.goals-dialog #goal-new-title')`, at + 'the form', 5000);
            const form = await ev(`(() => { const d = document.querySelector('.goals-dialog'), t = d.querySelector('#goal-new-description'); return { tag: t && t.tagName, label: t && d.querySelector('label[for="goal-new-description"]').textContent.trim(), max: t && t.maxLength, rows: t && t.rows, driverHelp: /the agent who looks after it\\.?$/m.test([...d.querySelectorAll('.goals-note')].map(n => n.textContent).join('\\n')), driverHelpId: !!d.querySelector('#goal-new-driver-help'), describedby: d.querySelector('#goal-new-driver').getAttribute('aria-describedby') }; })()`);
            assert.deepEqual(form, { tag: 'TEXTAREA', label: 'What should be true', max: 2000, rows: 10, driverHelp: false, driverHelpId: false, describedby: null }, at + 'the Description field, and the repeated Driver line is gone');
            assert.match(await ev(`document.querySelector('.goals-dialog #goal-new-driver').closest('label').textContent`), /^Driver/, at + 'the Driver field keeps its own label (a chip in the bar, #12724)');
            await waitFor(`!!document.querySelector('.goals-dialog .ac-picker input')`, at + 'the picture button', 5000);
            assert.equal(await ev(`(() => { const h = document.querySelector('.goals-dialog .ac-images-hint'); return h && h.getClientRects().length > 0 ? h.textContent : null; })()`), 'Pictures are shared with this team\'s agents as they are; nothing is hidden.', at + 'the quiet line about who sees a picture is beside Add image');

            // the count shows only near the limit
            await ev(`(() => { const t = document.querySelector('.goals-dialog #goal-new-description'); t.value = 'x'.repeat(1400); t.dispatchEvent(new Event('input')); return true; })()`);
            assert.equal(await ev(`document.querySelector('.goals-dialog .goals-count').hidden`), true, at + 'no count far from the limit');
            await ev(`(() => { const t = document.querySelector('.goals-dialog #goal-new-description'); t.value = 'x'.repeat(1700); t.dispatchEvent(new Event('input')); return true; })()`);
            assert.equal(await ev(`document.querySelector('.goals-dialog .goals-count').textContent`), '1700 / 2000', at + 'the live count near the limit');
            await ev(`(() => { const t = document.querySelector('.goals-dialog #goal-new-description'); t.value = 'The first line.\\nThe second line.'; t.dispatchEvent(new Event('input')); return true; })()`);
            assert.equal(await ev(`document.querySelector('.goals-dialog .goals-count').hidden`), true, at + 'the count goes again');

            // pictures: pick, paste, drop; each is stored as it is added
            await pick([['one.png', 'image/png']]);
            await waitFor(`document.querySelectorAll('.goals-dialog .ac-thumb-img').length === 1`, at + 'a thumbnail', 5000); await settled();
            await ev(`(() => { const ta = document.querySelector('.goals-dialog #goal-new-description'); ta.focus(); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: window.__dt([window.__file('pasted.png', 'image/png')]), bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('.goals-dialog .ac-thumb-img').length === 2`, at + 'a pasted picture', 5000); await settled();
            await ev(`(() => { const f = document.querySelector('.goals-dialog form'); f.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__dt([window.__file('dropped.webp', 'image/webp')]), bubbles: true, cancelable: true })); f.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt([window.__file('dropped.webp', 'image/webp')]), bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('.goals-dialog .ac-thumb-img').length === 3`, at + 'a dropped picture', 5000); await settled();
            assert.deepEqual(await ev(`window.__up.map(x => x.ct)`), ['image/png', 'image/png', 'image/webp'], at + 'each went up raw with its type');
            // Mark up (#11654): the first picture's marked copy goes up with version_of=<its hex> and takes its place; the editor says the original is kept
            await ev(`document.querySelector('.goals-dialog .ac-thumb-markup').click(); true`);
            await waitFor(`!!document.querySelector('dialog.markup-dialog[open]')`, at + 'the editor opens', 8000);
            assert.match(await ev(`document.querySelector('.markup-kept').textContent`), /^The original is kept as an earlier version/, at + 'the kept-original line');
            await ev(`(() => { const c = document.querySelector('.markup-canvas'), p = (type, x) => c.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: 0, bubbles: true, cancelable: true })); p('pointerdown', 0); p('pointermove', 1); p('pointerup', 1); [...document.querySelectorAll('.markup-foot button')].find(b => b.textContent === 'Done').click(); return true; })()`);
            await waitFor(`window.__up.length === 4`, at + 'the marked upload', 5000); await settled();
            assert.match(await ev(`window.__up[3].url`), /\/goal-images\?version_of=e{63}1$/, at + 'goal-images with version_of the first picture');
            assert.equal(await ev(`document.querySelectorAll('.goals-dialog .ac-thumb-img').length`), 3, at + 'still three pictures');
            // a failed one blocks Create until it is removed
            await ev(`window.__fail = true; true`);
            await pick([['toolarge.png', 'image/png']]);
            await waitFor(`document.querySelectorAll('.goals-dialog .ac-thumb-failed').length === 1`, at + 'the failed picture', 5000);
            assert.equal(await ev(`document.querySelector('.goals-dialog button[type=submit]').disabled`), true, at + 'Create is blocked by a failed picture');
            await ev(`document.querySelector('.goals-dialog .ac-thumb-failed .ac-thumb-remove').click(); window.__fail = false; true`);
            assert.equal(await ev(`document.querySelector('.goals-dialog button[type=submit]').disabled`), false, at + 'removed, Create is open again');
            assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, at + 'the form does not scroll sideways');
            if (mobile) assert.deepEqual(await ev(`[...document.querySelectorAll('.goals-dialog button')].filter(b => b.getClientRects().length).map(b => [b.textContent, Math.round(b.getBoundingClientRect().height)]).filter(x => x[1] < 44 && b0(x[0]))`.replace('b0(x[0])', 'x[0] !== "\\u2190"')), [], at + 'the form\'s buttons are 44 px tall');

            // Create: the description is the outcome, the pictures are the stored hexes in order
            await ev(`(() => { const t = document.querySelector('.goals-dialog #goal-new-title'); t.value = 'Fix the lock'; t.dispatchEvent(new Event('input')); document.querySelector('.goals-dialog form').requestSubmit(); return true; })()`);
            await waitFor(`window.__posts.length === 1`, at + 'the post', 5000);
            const post = await ev(`window.__posts[0]`);
            assert.equal(post.title, 'Fix the lock');
            await waitFor(`/Goal created\\. The Orchestrator was told\\./.test(document.querySelector('#toast-host')?.textContent || '')`, at + 'a goal the Orchestrator was told of says so in a toast (#11880)', 5000);
            assert.equal(post.outcome, 'The first line.\nThe second line.', at + 'the Description is the outcome, line breaks kept');
            assert.equal(post.images.length, 3, at + 'three pictures named');
            assert.ok(post.images.every(x => /^e{63}[0-9a-f]$/.test(x)) && new Set(post.images).size === 3, at + 'each a stored artifact ' + JSON.stringify(post.images));

            // the goal's page: Description, its line breaks, its pictures
            await load(`/team/${B}/goals/${G}`, w, h, mobile, G);
            await waitFor(`!!document.querySelector('#team-panel-goals .goals-facts')`, at + 'the goal page', 15000);
            assert.equal(await ev(`[...document.querySelectorAll('#team-panel-goals .goals-facts dt')].map(d => d.textContent).join()`), 'Description,Done when', at + 'the page says Description');
            assert.equal(await ev(`getComputedStyle(document.querySelector('#team-panel-goals .goals-facts dd')).whiteSpace`), 'pre-line', at + 'and keeps its line breaks');
            assert.equal(await ev(`document.querySelector('#team-panel-goals .goals-facts dd').textContent`), OUTCOME);
            await ev(`window.dispatchEvent(new Event('focus')); true`); // the page reads its goal again: now through the stub, which adds the pictures
            await waitFor(`document.querySelectorAll('#team-panel-goals .goal-pic-img').length === 2`, at + 'its pictures', 8000);
            await waitFor(`[...document.querySelectorAll('#team-panel-goals .goal-pic-img')].every(i => i.complete && i.naturalWidth > 0)`, at + 'drawn', 8000);
            assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, at + 'the page does not scroll sideways');
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS the New goal form: Description, pictures, no repeated Driver line; the goal page shows both');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
