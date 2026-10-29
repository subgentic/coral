// The composer's image thumbnail shows the whole picture and opens it larger (#10147, the Desktop tester: a pasted screenshot was a cropped 40 px square, so a person could not tell which picture it was): the thumbnail fits the picture
// (object-fit contain, never a cropped strip), is a button named "Enlarge image" and opens the picture full size in its own tab. 1280 px, isolated dev server, the harness's stand-in agents; the picture is a 120x40 PNG made in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.__m.add('thumb-bot', 'A', 3, { sleeping: false, session_id: 'thumb-bot-id' }); true`);
        await waitFor(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(s => s.session_id === 'thumb-bot-id')`, 'the agent', { timeout: 8000 });
        await ev(`window.selectLiveSession('thumb-bot', 'claude', 'thumb-bot-id', 'local'); true`);
        await waitFor(`!!document.getElementById('image-attachments')`, 'the composer', { timeout: 8000 });
        await ev(`(async () => {
            const c = document.createElement('canvas'); c.width = 120; c.height = 40; c.getContext('2d').fillRect(0, 0, 120, 40);
            const blob = await new Promise(r => c.toBlob(r, 'image/png')); const url = URL.createObjectURL(blob);
            const m = await import((window.__coralStatic || '/static/') + 'image_composer.js');
            m.getPendingAttachments().push({ filename: 'wide.png', previewUrl: url, path: '/tmp/wide.png' });
            m.renderAttachments();
            window.__opened = []; window.open = (u, t, f) => { window.__opened.push([u, t, f]); return null; };
            return true; })()`);
        await waitFor(`document.querySelectorAll('#image-attachments .image-attachment img').length === 1`, 'the thumbnail', { timeout: 6000 });
        const t = await ev(`(() => { const i = document.querySelector('#image-attachments .image-attachment img'); const cs = getComputedStyle(i); const b = i.closest('button'); return { fit: cs.objectFit, w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height), button: b ? b.getAttribute('aria-label') : null }; })()`);
        assert.equal(t.fit, 'contain', 'the whole picture is shown, not a cropped square: ' + JSON.stringify(t));
        assert.ok(t.w > t.h, 'a wide picture gets a wide box: ' + JSON.stringify(t));
        assert.match(String(t.button), /^Enlarge image/, 'the thumbnail is a button that enlarges it: ' + JSON.stringify(t));
        await ev(`document.querySelector('#image-attachments .image-attachment img').closest('button').click(); true`);
        const opened = await ev(`window.__opened`);
        assert.equal(opened.length, 1, 'clicking it opens the picture: ' + JSON.stringify(opened));
        assert.match(opened[0][0], /^blob:/, 'the picture itself, full size');
        console.log('PASS the composer thumbnail shows the whole picture and opens it larger');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
