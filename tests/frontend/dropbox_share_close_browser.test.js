// The Share via Dropbox dialog closes three ways, with real mouse and key events, and its × sits at the right of the title's line (#15544, the Operator:
// "can't close the share link modal"; the × was alone on a second row under the title). It is opened the way the Operator did: over the file's open
// review dialog (the artifact viewer), after a link was made; the viewer under it must stay usable. The Dropbox answers are stubs: no real call.
const { connect } = require('./agent_view_harness');
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;
const LINK = 'https://www.dropbox.com/scl/fi/abc/design-14170.md?rlkey=k&dl=0';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const click = async sel => { // a real press at the control's centre: a control another layer covers does not get it
        const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, top: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === e || e.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)) }; })()`);
        if (!r) return false;
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        return r.top;
    };
    const escape = async () => { const o = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }; await client.Input.dispatchKeyEvent({ type: 'keyDown', ...o }); await client.Input.dispatchKeyEvent({ type: 'keyUp', ...o }); };
    const shut = sel => waitFor(`!document.querySelector('${sel}[open]')`, 'closed', 2500).then(() => true, () => false);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const inner = window.fetch; const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                    if (p === '/api/dropbox/status') return json({ connected: true, state: 'connected' });
                    if (p === '/api/dropbox/share/${H3}' && m === 'GET') return json({ connected: true, name: 'design-14170.md', size: 14336, version: 3, can_expire: true, team: '', secret: false, folder: '/Shared from Coral/team-a', shares: [] });
                    if (p === '/api/dropbox/share/${H3}' && m === 'POST') return json({ id: 5, name: 'design-14170.md', folder: '/Shared from Coral/team-a', audience: 'public', link: '${LINK}', expires_at: '2026-12-09T10:00:00Z', version: 3 });
                    return inner(u, o); }; return true; })()`);
            for (const way of ['x', 'Done', 'Escape']) {
                const at = `${tag}, ${way}`;
                await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer('${H3}', { filename: 'design-14170.md', server: 'local', sourceNamed: true }); return true; })()`);
                await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-dropbox-share') && !document.querySelector('#artifact-viewer .artifact-viewer-dropbox-share').hidden`, 'the Share via Dropbox item', 8000);
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); document.querySelector('#artifact-viewer .artifact-viewer-dropbox-share').click(); true`);
                await waitFor(`!!document.querySelector('#dropbox-share-dialog[open] .dropbox-share-choices')`, 'the dialog', 8000);
                await ev(`document.querySelector('#dropbox-share-dialog input[value="public"]').click(); document.getElementById('dropbox-share-link-ok').click(); [...document.querySelectorAll('#dropbox-share-dialog .modal-footer button')].pop().click(); true`);
                await waitFor(`!!document.querySelector('#dropbox-share-dialog .dropbox-share-link')`, 'the link', 6000);
                if (way === 'x' && process.env.CORAL_SCREENSHOT_DIR) { await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/share-dialog-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
                if (way === 'x') { // where the × is: on the title's line, at the right
                    const g = await ev(`(() => { const d = document.getElementById('dropbox-share-dialog').getBoundingClientRect(), t = document.getElementById('dropbox-share-title').getBoundingClientRect(), x = document.querySelector('#dropbox-share-dialog .modal-close').getBoundingClientRect(); return { dl: d.left, dr: d.right, tt: t.top, tb: t.bottom, xt: x.top, xb: x.bottom, xl: x.left, xr: x.right, tr: t.right }; })()`);
                    check(g.xt < g.tb && g.xb > g.tt, `${at}: the × is on the title's line, not under it: ${JSON.stringify(g)}`);
                    check(g.xl >= g.tr - 1 && g.xr <= g.dr + 1 && g.dr - g.xr < 40, `${at}: the × is at the dialog's right: ${JSON.stringify(g)}`);
                }
                if (way === 'x') check(await click('#dropbox-share-dialog .modal-close'), `${at}: the × is the topmost thing at its centre`);
                if (way === 'Done') check(await ev(`(() => { const b = [...document.querySelectorAll('#dropbox-share-dialog .modal-footer button')].find(b => b.textContent === 'Done'); if (b) b.id = 'dropbox-done-probe'; return !!b; })()`) && await click('#dropbox-done-probe'), `${at}: Done is the topmost thing at its centre`);
                if (way === 'Escape') await escape();
                check(await shut('#dropbox-share-dialog'), `${at}: the dialog closed`);
                const under = await ev(`(() => { const v = document.getElementById('artifact-viewer'); const m = document.querySelector('#artifact-viewer .artifact-viewer-more'); return { open: !!v && !v.hidden && getComputedStyle(v).display !== 'none', inert: !!v?.closest('[inert]'), more: !!m && m.getClientRects().length > 0 }; })()`);
                check(under.open && !under.inert && under.more, `${at}: the review dialog under it is still open and usable: ${JSON.stringify(under)}`);
                const reach = await click('#artifact-viewer .artifact-viewer-more');
                check(reach, `${at}: More actions can be pressed again`);
                await ev(`window.closeArtifactViewer ? window.closeArtifactViewer() : (document.getElementById('artifact-viewer').hidden = true); true`);
            }
        }
        if (found.length) { console.log(found.map(f => 'FAIL ' + f).join('\n')); throw new Error('share dialog close checks failed:\n' + found.join('\n')); }
        console.log('PASS share dialog: x, Done and Escape close it over the review dialog; the x is on the title line');
    } finally { await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
