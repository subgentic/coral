// Share through Coral Hub (#16109), the dialog as a person sees it at 1280 and 390, light and dark: with no Dropbox connected on this computer the dialog says
// "Through Coral Hub", opens the Hub's page for Share and Stop sharing (nothing else: no call to the Hub), says the Hub's page is the record and that Stop sharing deletes
// the file from Dropbox; a file that looks like it holds a secret shows Upload anyway (a local call). The "before" shot is the same dialog with no Hub view (what main shows).
// The server's answers are the page's fetch. Screenshots go to CORAL_SCREENSHOT_DIR. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;
const PAGE = `https://hub.example.test/dropbox/share/srv_1/${H3}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await sleep(300); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${name}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const text = () => ev(`document.getElementById('dropbox-share-dialog').textContent`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const theme of ['light', 'dark']) {
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
                const tag = `${w}px ${theme}`;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev);
                await ev(STUB);
                await ev(`(() => { const inner = window.fetch; window.__calls = []; window.__opened = [];
                    window.open = (...a) => { window.__opened.push(a); return {}; };
                    window.__hub = null;
                    const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                        if (p === '/api/dropbox/share/${H3}' && m === 'GET') { window.__calls.push(m + ' ' + p); return json(window.__hub ? { connected: false, hub: window.__hub } : { connected: false }); }
                        if (p === '/api/dropbox/upload-anyway/${H3}' && m === 'POST') { window.__calls.push(m + ' ' + p); return json({}); }
                        return inner(u, o); };
                    return true; })()`);
                const open = async () => {
                    await ev(`document.getElementById('dropbox-share-dialog')?.close?.(); window.__calls = []; window.__opened = []; (async () => { const m = await import(${S} + 'dropbox_share.js'); m.openShareDialog({ hex: '${H3}', filename: 'release-plan.md', opener: document.body }); })(); true`);
                    await waitFor(`!!document.querySelector('#dropbox-share-dialog[open] .modal-body') && !/Reading your Dropbox/.test(document.getElementById('dropbox-share-dialog').textContent)`, 'the dialog', 8000);
                };

                console.log(`${tag}: before (no Hub view)`);
                await open();
                check(`${tag}: no Hub view says to connect Dropbox`, /Connect Dropbox in Settings/.test(await text()));
                await shot(`share-hub-before-${w}-${theme}`);

                console.log(`${tag}: through Coral Hub`);
                await ev(`window.__hub = { offered: true, url: '${PAGE}', flagged: false }; true`);
                await open();
                const t = await text();
                check(`${tag}: says Through Coral Hub`, /Through Coral Hub/.test(t));
                check(`${tag}: says the Hub's page is the record`, /its page is the record/.test(t));
                check(`${tag}: Stop sharing says the Hub deletes the file`, /Coral Hub deletes the file from Dropbox/.test(t));
                check(`${tag}: a plain file has no Upload anyway`, !(await ev(`[...document.querySelectorAll('#dropbox-share-dialog button')].some(b => /Upload anyway/.test(b.textContent))`)));
                check(`${tag}: no sideways scroll`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
                await shot(`share-hub-after-${w}-${theme}`);
                await ev(`[...document.querySelectorAll('#dropbox-share-dialog button')].find(b => /Share on Coral Hub/.test(b.textContent)).click(); [...document.querySelectorAll('#dropbox-share-dialog button')].find(b => /Stop sharing/.test(b.textContent)).click(); true`);
                check(`${tag}: Share and Stop sharing only open the Hub's page`, (await ev(`JSON.stringify(window.__opened)`)) === JSON.stringify([[PAGE, '_blank', 'noopener,noreferrer'], [PAGE, '_blank', 'noopener,noreferrer']]), await ev(`JSON.stringify(window.__opened)`));
                check(`${tag}: no call but the local read`, (await ev(`JSON.stringify(window.__calls)`)) === JSON.stringify([`GET /api/dropbox/share/${H3}`]));

                console.log(`${tag}: a held file`);
                await ev(`window.__hub = { offered: true, url: '${PAGE}', flagged: true }; true`);
                await open();
                check(`${tag}: says it looks like a secret`, /looks like it holds a secret/.test(await text()));
                await shot(`share-hub-held-${w}-${theme}`);
                await ev(`[...document.querySelectorAll('#dropbox-share-dialog button')].find(b => /Upload anyway/.test(b.textContent)).click(); true`);
                await waitFor(`/Allowed for 10 minutes/.test(document.getElementById('dropbox-share-dialog').textContent)`, 'Upload anyway answered', 6000);
                check(`${tag}: Upload anyway is a local call and opens nothing`, (await ev(`JSON.stringify(window.__calls.slice(-1))`)) === JSON.stringify([`POST /api/dropbox/upload-anyway/${H3}`]) && (await ev(`window.__opened.length`)) === 0);
                await ev(`document.getElementById('dropbox-share-dialog').close(); true`);
            }
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Share through Coral Hub checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
