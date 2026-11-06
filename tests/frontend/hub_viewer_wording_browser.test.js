// #13979 (Hub beta, coral-hub): served as the Hub serves it (boot flag "cloud"), a file's viewer says ONE thing about comments (the reason they cannot be added here, then "No open comments." and never "Select some text to add one"), and a toast
// (Approve's) does not sit over the viewer's Close. The artifact and its comments are stubbed in the page (the isolated server has no computer behind it).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { safePaused } = require('./helpers/paused');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const HEX = 'c'.repeat(64);

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Network, Fetch, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); await new Promise(r => setTimeout(r, 400)); /* sleep-ok: transitions */ fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
        Runtime.exceptionThrown(x => console.log('PAGE-EXC ' + JSON.stringify(x.exceptionDetails).slice(0, 300)));
        await Network.setCacheDisabled({ cacheDisabled: true });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/account*`, requestStage: 'Request' },
            { urlPattern: `${BASE}/api/servers*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/sessions/live*`, requestStage: 'Request' }] });
        const json = (id, status, body) => Fetch.fulfillRequest({ requestId: id, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64') });
        safePaused(client, async e => {
            const u = e.request.url;
            if (u.endsWith('/auth/session')) return json(e.requestId, 200, { authenticated: true, email: 'tester@example.com', csrf: 'x' });
            if (/\/api\/account(\?|$)/.test(u)) return json(e.requestId, 200, {});
            if (/\/api\/servers(\?|$)/.test(u)) return json(e.requestId, 200, { servers: [{ id: 'm1', label: 'Laptop', status: 'online' }] });
            if (/\/api\/sessions\/live(\?|$)/.test(u)) return json(e.requestId, 200, { sessions: [], servers: [{ id: 'm1', label: 'Laptop', status: 'online' }] });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
            await Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`document.body.classList.contains('cloud-mode')`, 'cloud mode', { timeout: 15000 });
        assert.equal(await ev(`(async () => (await import(${S} + 'server_base.js')).isCloud())()`), true, 'the page is served as the Hub serves it');
        await ev(`(() => { const real = window.fetch; const j = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u); if (url.includes('/artifacts/${HEX}')) {
                if (url.includes('/comments')) return j({ comments: [], locked: false, you: { can_comment: true, can_lock: true } });
                if (/\\/(readers|versions|review|meta)/.test(url)) return j({ error: 'not here' }, 404);
                return Promise.resolve(new Response('# Plan\\n\\nSome text.\\n', { status: 200, headers: { 'Content-Type': 'text/markdown' } })); }
                return real(u, o); }; return true; })()`);
        await ev(`(async () => { const { loadArtifactInventory } = await import(${S} + 'artifact_source.js'); await loadArtifactInventory(); return true; })()`); // the page's computer list, as the viewer needs it
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', server: 'm1', board: 'team-a' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .ac-toggle:not([hidden])')`, 'the Comments button', { timeout: 10000 });
        await ev(`document.querySelector('#artifact-viewer .ac-toggle').click(); true`); // no comments yet: the panel opens on the button
        await waitFor(`!!document.querySelector('#artifact-viewer .ac-readonly')`, 'the read-only reason', { timeout: 10000 });
        const panel = await ev(`(() => { const r = document.querySelector('#artifact-viewer .ac-readonly'); return { reason: r.textContent, panel: r.parentElement.textContent }; })()`);
        await shot('hub-comments-readonly');
        assert.equal(panel.reason, 'Comments can be added on the computer itself.', JSON.stringify(panel));
        assert.ok(/No open comments\./.test(panel.panel) && !/Select some text to add one/.test(panel.panel) && !/Use the button below/.test(panel.panel), 'one message, no contradiction: ' + JSON.stringify(panel));
        await ev(`(async () => { const n = await import(${S} + 'notifications.js'); n.showToast('Approved. Planner was told.'); return true; })()`);
        await waitFor(`!!document.querySelector('#toast-host > .toast')`, 'the toast', { timeout: 4000 });
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the toast slides in over 0.3 s
        const over = await ev(`(() => { const t = document.querySelector('#toast-host > .toast').getBoundingClientRect(), c = document.querySelector('#artifact-viewer .artifact-viewer-close').getBoundingClientRect(); return { toast: [t.left, t.top, t.right, t.bottom].map(Math.round), close: [c.left, c.top, c.right, c.bottom].map(Math.round), overlap: !(t.right <= c.left || t.left >= c.right || t.bottom <= c.top || t.top >= c.bottom) }; })()`);
        await shot('hub-toast-vs-close');
        assert.equal(over.overlap, false, 'the toast does not cover Close: ' + JSON.stringify(over));
        console.log('PASS the Hub-served viewer says one thing about comments and its toast leaves Close free');
    } catch (e) { try { await shot('hub-viewer-failed'); console.log('STATE ' + JSON.stringify(await ev(`(() => { const d = document.getElementById('artifact-viewer'); return d ? { hidden: d.hidden, header: d.querySelector('.artifact-viewer-header')?.textContent.trim().slice(0, 200), body: d.querySelector('.artifact-viewer-body')?.textContent.trim().slice(0, 200), toggle: !!d.querySelector('.ac-toggle'), toggleHidden: d.querySelector('.ac-toggle')?.hidden } : 'no viewer'; })()`))); } catch {} console.log('FAIL ' + (e && e.stack || e)); process.exitCode = 1; }
    finally { try { await client.close(); } catch {} }
})();
