// Share to Google Docs (#20010, slice A): the item sits in the file's More menu next to Share via Dropbox, only while the experimental switch is on and the file is Markdown;
// its dialog says when Google is not connected, makes the Doc on one press and shows Open the Doc, and shows a file already shared with its link; Escape closes it.
// The server answers are stubs: no real call to Google.
const { connect } = require('./agent_view_harness');
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;
const DOC = 'https://docs.google.com/document/d/abc123/edit';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const escape = async () => { const o = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }; await client.Input.dispatchKeyEvent({ type: 'keyDown', ...o }); await client.Input.dispatchKeyEvent({ type: 'keyUp', ...o }); };
    const open = async (file, mediaType) => {
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer('${H3}', { filename: ${JSON.stringify(file)}, mediaType: ${JSON.stringify(mediaType)}, server: 'local', sourceNamed: true }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-gdoc-share')`, 'the viewer', 8000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the item appears after the status read answers
    };
    const itemShown = () => ev(`(() => { const b = document.querySelector('#artifact-viewer .artifact-viewer-gdoc-share'); return !!b && !b.hidden; })()`);
    const stub = state => ev(`(() => { const inner = window.__gdocInner || window.fetch; window.__gdocInner = inner; window.__gdocPosts = 0; const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
        const st = ${JSON.stringify(state)};
        window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
            if (p === '/api/gdoc/status') return json(st);
            if (p === '/api/artifacts/${H3}/gdoc/share' && m === 'POST') { window.__gdocPosts++; return json({ doc_id: 'abc123', url: '${DOC}', created: true, requests: 0 }); }
            if (p === '/api/artifacts/${H3}/gdoc/sync' && m === 'POST') { window.__gdocSync = JSON.parse(o.body); return json({ paused: JSON.parse(o.body).paused }); }
            if (p === '/api/artifacts/${H3}/gdoc/share' && m === 'DELETE') { window.__gdocStopped = true; return json({ unshared: true }); }
            if (p === '/api/dropbox/status') return json({ connected: false, state: 'disconnected' });
            return inner(u, o); }; return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);

        await stub({ enabled: false });
        await open('plan.md', 'text/markdown');
        check(!(await itemShown()), 'the item is hidden while the switch is off');

        await stub({ enabled: true, connected: true });
        await open('picture.png', 'image/png');
        check(!(await itemShown()), 'the item is hidden for a file that is not Markdown');
        await open('plan.md', 'text/markdown');
        check(await itemShown(), 'the item is offered for a Markdown file while the switch is on');
        const order = await ev(`(() => { const a = [...document.querySelectorAll('#artifact-viewer .menu-item')].map(e => e.className); return a.findIndex(c => c.includes('gdoc-share')) - a.findIndex(c => c.includes('dropbox-share')); })()`);
        check(order === 1, `the item sits right after Share via Dropbox (${order})`);

        // not connected
        await stub({ enabled: true, connected: false });
        await open('plan.md', 'text/markdown');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); document.querySelector('#artifact-viewer .artifact-viewer-gdoc-share').click(); true`);
        await waitFor(`!!document.querySelector('#gdoc-share-dialog[open]') && /not connected/.test(document.querySelector('#gdoc-share-dialog .modal-body').textContent)`, 'the not connected line', 8000);
        await escape();
        await waitFor(`!document.querySelector('#gdoc-share-dialog[open]')`, 'Escape closes it', 3000).catch(() => check(false, 'Escape did not close the dialog'));

        // connected, not shared: one press makes the Doc
        await stub({ enabled: true, connected: true });
        await open('plan.md', 'text/markdown');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); document.querySelector('#artifact-viewer .artifact-viewer-gdoc-share').click(); true`);
        await waitFor(`!!document.querySelector('#gdoc-share-dialog[open] .modal-footer .btn-primary')`, 'the Share button', 8000);
        check(await ev(`document.querySelector('#gdoc-share-dialog .modal-footer .btn-primary').textContent`) === 'Share to Google Docs', 'the primary button says Share to Google Docs');
        check(await ev(`window.__gdocPosts`) === 0, 'nothing is sent before the press');
        await ev(`document.querySelector('#gdoc-share-dialog .modal-footer .btn-primary').click(); true`);
        await waitFor(`!!document.querySelector('#gdoc-share-dialog .modal-footer a[href="${DOC}"]')`, 'Open the Doc', 6000);
        check(await ev(`window.__gdocPosts`) === 1, 'one press sends one share');
        check(await ev(`(() => { const a = document.querySelector('#gdoc-share-dialog .modal-footer a'); return a.target === '_blank' && /noopener/.test(a.rel); })()`), 'Open the Doc opens a new tab safely');
        await ev(`[...document.querySelectorAll('#gdoc-share-dialog .modal-footer button')].pop().click(); true`);
        check(await waitFor(`!document.querySelector('#gdoc-share-dialog[open]')`, 'Done closes', 3000).then(() => true, () => false), 'Done closes the dialog');

        // already shared
        await stub({ enabled: true, connected: true, shared: true, url: DOC });
        await open('plan.md', 'text/markdown');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); document.querySelector('#artifact-viewer .artifact-viewer-gdoc-share').click(); true`);
        await waitFor(`!!document.querySelector('#gdoc-share-dialog[open] .modal-footer a[href="${DOC}"]')`, 'the link to the existing Doc', 8000);
        check(/now/.test(await ev(`document.querySelector('#gdoc-share-dialog .modal-footer .btn-primary').textContent`)), 'a shared file offers Share this version now');
        const foot = () => ev(`[...document.querySelectorAll('#gdoc-share-dialog .modal-footer button')].filter(b => !b.hidden).map(b => b.textContent)`);
        const names = await foot();
        check(names.includes('Pause syncing') && names.includes('Stop sharing'), 'a shared file offers Pause syncing and Stop sharing: ' + names.join('|'));
        await ev(`[...document.querySelectorAll('#gdoc-share-dialog .modal-footer button')].find(b => b.textContent === 'Pause syncing').click(); true`);
        await waitFor(`window.__gdocSync && window.__gdocSync.paused === true`, 'Pause sends paused true', 4000).catch(() => check(false, 'Pause did not send the pause'));
        await ev(`[...document.querySelectorAll('#gdoc-share-dialog .modal-footer button')].find(b => b.textContent === 'Stop sharing').click(); true`);
        await waitFor(`window.__gdocStopped === true && /Sharing stopped/.test(document.querySelector('#gdoc-share-dialog .modal-body').textContent)`, 'Stop sharing says it stopped', 4000).catch(() => check(false, 'Stop sharing did not stop and say so'));

        // phone width: the dialog fits 390 px and every footer button is reachable
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
        await stub({ enabled: true, connected: true, shared: true, url: DOC });
        await open('plan.md', 'text/markdown');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); document.querySelector('#artifact-viewer .artifact-viewer-gdoc-share').click(); true`);
        await waitFor(`!!document.querySelector('#gdoc-share-dialog[open] .modal-footer a[href="${DOC}"]')`, 'the dialog at 390 px', 8000);
        const fit = await ev(`(() => { const d = document.querySelector('#gdoc-share-dialog'); const r = d.getBoundingClientRect(); const out = [...d.querySelectorAll('.modal-footer button, .modal-footer a')].filter(e => !e.hidden).filter(e => { const b = e.getBoundingClientRect(); return b.left < -0.5 || b.right > 390.5; }).length; return { left: r.left, right: r.right, out }; })()`);
        check(fit.left >= -0.5 && fit.right <= 390.5, 'the dialog fits a 390 px screen: ' + JSON.stringify(fit));
        check(fit.out === 0, 'every footer button is inside a 390 px screen: ' + JSON.stringify(fit));
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

        if (found.length) { console.log(found.map(f => 'FAIL ' + f).join('\n')); throw new Error('gdoc share checks failed:\n' + found.join('\n')); }
        console.log('PASS gdoc share: item next to Dropbox, hidden when off or not Markdown, not connected, one press makes the Doc, an existing Doc is linked');
    } finally { await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
