// #13299 (Developer experience, filming demo v5): an open comments panel (a file's in the viewer; a goal's tab uses the same panel) showed an agent's reply only when it was reopened. It now reads the thread every few seconds
// while it is open and the page is visible, and redraws when the thread differs: a reply that arrives while the panel is open appears without reopening, the panel keeps its scroll, a thread that did not change is not
// redrawn (so a draft or a focus is not disturbed), and a closed viewer reads nothing. The comments routes are page stubs (as in artifact_comments_browser); the poll is 400 ms here (the product's is 8 s). 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'e'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the poll is on a timer: a stretch with no change is the thing measured
    const STUB = `(() => {
        const real = window.fetch; window.__gets = 0;
        const OWNER = { kind: 'owner', issuer: 'local', subject: 'Operator' };
        window.__cs = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, parent_id: null, anchor: { whole: true }, body: 'Comment number ' + (i + 1) + ' on the whole file.', author: OWNER, created_at: new Date(Date.now() - (40 - i) * 60000).toISOString() }));
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comments') && method === 'GET') { window.__gets++;
                return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: true, can: { reply: true, edit: true, delete: true, resolve: true } })), locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true } }); }
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response('# A note\\n\\nSome words.', { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o); };
        return true; })()`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: 'window.__coralCommentsPollMs = 400;' });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(STUB);
        await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'note.md', mediaType: 'text/markdown' })).then(() => true)`);
        await waitFor(`!!document.querySelector('.ac-toggle') && !document.querySelector('.ac-toggle').hidden`, 'the Comments button', 10000);
        if ((await ev(`document.querySelector('.ac-toggle').getAttribute('aria-expanded')`)) !== 'true') await ev(`document.querySelector('.ac-toggle').click(); true`);
        await waitFor(`/Comment number 30/.test(document.querySelector('.ac-panel')?.textContent || '')`, 'the thread in the panel', 10000);

        console.log('1. A reply that arrives while the panel is open appears without reopening, and the panel keeps its scroll');
        await ev(`(() => { const p = document.querySelector('.ac-panel'); p.scrollTop = 400; window.__top = p.scrollTop; return true; })()`);
        const top = await ev(`window.__top`);
        assert.ok(top > 100, 'the thread is long enough to scroll: ' + top);
        await ev(`window.__cs.push({ id: 31, parent_id: 1, anchor: null, body: 'The agent replied: it is done now.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }); true`);
        await waitFor(`/The agent replied: it is done now/.test(document.querySelector('.ac-panel')?.textContent || '')`, 'the reply, with no reopening', 10000);
        const after = await ev(`document.querySelector('.ac-panel').scrollTop`);
        assert.ok(Math.abs(after - top) <= 2, `the scroll is kept (${top} before, ${after} after)`);
        await shot('comments-live-reply');
        console.log('   ✓');

        console.log('2. A thread that did not change is not redrawn (a draft or the focus is not disturbed)');
        await ev(`document.querySelector('.ac-panel .ac-card').dataset.mark = 'same'; window.__g0 = window.__gets; true`);
        await sleep(1600); // sleep-ok: a stretch of the poll with no change is the thing measured
        const quiet = await ev(`({ polled: window.__gets - window.__g0, kept: document.querySelector('.ac-panel .ac-card')?.dataset.mark })`);
        assert.ok(quiet.polled >= 2, 'the panel keeps reading while it is open: ' + JSON.stringify(quiet));
        assert.equal(quiet.kept, 'same', 'the cards were not redrawn when nothing changed: ' + JSON.stringify(quiet));
        console.log('   ✓');

        console.log('3. A closed viewer reads nothing');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); window.__g1 = window.__gets; true`);
        await sleep(1500); // sleep-ok: a closed viewer's silence is the thing measured
        const idle = await ev(`window.__gets - window.__g1`);
        assert.equal(idle, 0, 'no reads after the viewer closed: ' + idle);
        console.log('   ✓');
        console.log('PASS comments live: a reply shows without reopening, the scroll is kept, an unchanged thread is not redrawn, a closed viewer reads nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
