// Run scripts in an HTML file's preview (#14730, design v3): the person turns them on for ONE version of a file, in the single-artifact viewer, and can turn them off at once.
// Real Chrome against an isolated Coral, the artifact and trust routes stubbed in the page; the real viewer, the real artifact_scripts.js and the real /static/artifact_host.html. 1280 px and 390 px.
// Checks: the plain preview offers "Run scripts…" and runs nothing; the confirmation says what it must and Cancel changes nothing; Run scripts trusts THIS digest, the frame is the host with
// sandbox="allow-scripts" and allow="" only, the file's script ran, and a bar OUTSIDE the frame says so; Turn off deletes the trust and the plain preview comes back; a trust that cannot be read,
// a file whose hash is not the trusted digest and a file over 2 MiB all leave scripts off; the file collection's preview offers nothing (scripts exist only in the single-artifact viewer).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HTML = '<h1>Pulse</h1><p id="o">idle</p><script>document.getElementById("o").textContent = "RAN";</script>';
const HEX = crypto.createHash('sha256').update(HTML).digest('hex');
const OTHER = 'cd'.repeat(32);
(async () => {
    const { client, Page, Runtime, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // the text of the file's own frame: found in the frame tree, read in an isolated world (the frame is an opaque origin: the page cannot reach it, the debugger can)
    // (Chrome puts an opaque-origin frame in a process of its own: the host's frame is a target of its own, and the file's frame is inside it. The plain preview's frame is a target (about:srcdoc) under the page.)
    const evalIn = async (sessionId, frameId) => {
        const { executionContextId } = await client.send('Page.createIsolatedWorld', { frameId, worldName: 'probe' }, sessionId);
        const r = await client.send('Runtime.evaluate', { contextId: executionContextId, expression: `(document.getElementById('o') || document.body).textContent`, returnByValue: true }, sessionId);
        return r.result.value;
    };
    const frameText = async (underHost) => {
        const { targetInfos } = await client.Target.getTargets();
        const iframes = targetInfos.filter(t => t.type === 'iframe');
        const host = iframes.find(t => /artifact_host\.html/.test(t.url));
        const target = underHost ? host : iframes.find(t => t.url === 'about:srcdoc');
        if (!target) return null;
        const { sessionId } = await client.Target.attachToTarget({ targetId: target.targetId, flatten: true });
        try {
            await client.send('Page.enable', {}, sessionId);
            const { frameTree } = await client.send('Page.getFrameTree', {}, sessionId);
            if (!underHost) return await evalIn(sessionId, frameTree.frame.id);
            const child = (frameTree.childFrames || [])[0];
                return child ? await evalIn(sessionId, child.frame.id) : null;
        } finally { await client.Target.detachFromTarget({ sessionId }).catch(() => {}); }
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => {
                window.__trust = new Set(); window.__trustCalls = []; window.__trustMode = 'ok'; window.__body = ${JSON.stringify(HTML)}; window.__bodyHex = ${JSON.stringify(HEX)};
                const orig = window.fetch.bind(window);
                const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
                    const t = /\\/api\\/artifacts\\/([a-f0-9]{64})\\/trust-preview/.exec(url);
                    if (t) { window.__trustCalls.push(method + ' ' + t[1]);
                        if (window.__trustMode === 'fail' && method === 'GET') return json({ error: 'boom' }, 500);
                        if (method === 'PUT') window.__trust.add(t[1]); if (method === 'DELETE') window.__trust.delete(t[1]);
                        return json({ id: t[1], trusted: window.__trust.has(t[1]) }); }
                    if (/\\/api\\/artifacts\\/[a-f0-9]{64}\\/(versions|comments)/.test(url)) return json(/comments/.test(url) ? { comments: [], locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} } : []);
                    if (/\\/api\\/artifacts\\/[a-f0-9]{64}/.test(url)) return Promise.resolve(new Response(window.__body, { status: 200, headers: { 'Content-Type': 'text/html' } }));
                    return orig(u, o); };
            })()`);
            const open = async (hex = HEX, frame = true) => {
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
                await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${hex}', { filename: 'pulse.html', mediaType: 'text/html', sourceNamed: false })).then(() => true)`);
                if (frame) await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`, `${w}: the HTML preview`, 10000);
            };
            const q = sel => ev(`(() => { const e = document.querySelector('#artifact-viewer ${sel}'); return !!e && !e.hidden && e.getClientRects().length > 0; })()`);
            const text = sel => ev(`(document.querySelector('#artifact-viewer ${sel}') || {}).textContent || ''`);
            const click = sel => ev(`document.querySelector('#artifact-viewer ${sel}').click(); true`);

            // 1. an untrusted file: the plain preview, the offer, nothing ran
            await open();
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-ask')`, `${w}: the Run scripts… offer`, 5000);
            assert.ok(await q('.artifact-scripts-ask'), `${w}: Run scripts… is shown`);
            assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-linked-preview iframe').getAttribute('sandbox')`), '', `${w}: the plain frame has the empty sandbox`);
            await sleep(400); // sleep-ok: a negative: a script that was going to run in the plain frame would have by now
            assert.equal(await frameText(false), 'idle', `${w}: no script ran in the plain preview`);
            await shot('scripts-offer-' + w);

            // 2. the confirmation: the words, Cancel changes nothing
            await click('.artifact-scripts-ask');
            assert.ok(await q('.artifact-scripts-sure'), `${w}: the confirmation opens in place`);
            assert.equal((await text('.artifact-scripts-sure p')).trim(), 'This file can run scripts. They can draw and animate. Coral limits what they can reach: no web requests, no cookies, no files. Do not trust a file you would not open.', `${w}: the confirmation says what the design says`);
            await shot('scripts-confirm-' + w);
            await click('.artifact-scripts-cancel');
            assert.ok(!(await q('.artifact-scripts-sure')) && (await q('.artifact-scripts-ask')), `${w}: Cancel closes it and the offer is back`);
            assert.deepEqual(await ev('window.__trustCalls.filter(c => !c.startsWith("GET"))'), [], `${w}: Cancel trusted nothing`);

            // 3. Run scripts: this digest is trusted, the host runs the file, the bar is outside the frame
            await click('.artifact-scripts-ask'); await click('.artifact-scripts-go');
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-bar')`, `${w}: the Scripts are on bar`, 10000);
            assert.deepEqual(await ev('window.__trustCalls.filter(c => !c.startsWith("GET"))'), ['PUT ' + HEX], `${w}: exactly this digest was trusted`);
            const f = await ev(`(() => { const fr = document.querySelector('#artifact-viewer .artifact-linked-preview iframe'), bar = document.querySelector('#artifact-viewer .artifact-scripts-bar');
                return { sandbox: fr.getAttribute('sandbox'), allow: fr.getAttribute('allow'), ref: fr.getAttribute('referrerpolicy'), src: fr.getAttribute('src'), barOutside: !fr.contains(bar) && bar.parentElement === fr.parentElement, bar: bar.textContent,
                    off: !!bar.querySelector('.artifact-scripts-off'), plainBanner: !!document.querySelector('#artifact-viewer .artifact-linked-notice'), chipHidden: document.querySelector('#artifact-viewer .artifact-viewer-sandbox').hidden }; })()`);
            assert.equal(f.sandbox, 'allow-scripts', `${w}: the frame is sandboxed with allow-scripts and nothing else`);
            assert.equal(f.allow, '', `${w}: no device or feature is allowed`);
            assert.equal(f.ref, 'no-referrer'); assert.equal(f.src, '/static/artifact_host.html');
            assert.ok(f.barOutside && /Scripts are on/.test(f.bar) && /no web requests, no cookies, no files/.test(f.bar) && !/blocks them/.test(f.bar) && f.off, `${w}: the bar is outside the frame, says Scripts are on and holds Turn off: ` + JSON.stringify(f));
            assert.ok(!f.plainBanner && f.chipHidden, `${w}: the plain banner and its chip are gone while scripts are on: ` + JSON.stringify(f));
            await waitFor(`true`, 'tick', 100);
            let ran = null; for (let i = 0; i < 200 && ran !== 'RAN'; i++) { ran = await frameText(true); if (ran !== 'RAN') await sleep(50); }
            assert.equal(ran, 'RAN', `${w}: the file's own script ran in the host's frame`);
            await shot('scripts-on-' + w);

            // 4. reopening the same version: trusted, runs; a newer version (another digest) is untrusted
            await open(); await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-bar')`, `${w}: trusted again on reopen`, 10000);
            await ev(`window.__body = '<p id="o">newer</p><script>1<\\/script>'`);
            await open(OTHER);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-ask')`, `${w}: another digest is offered, not run`, 5000);
            assert.ok(!(await q('.artifact-scripts-bar')), `${w}: a different version has no scripts`);
            await ev(`window.__body = ${JSON.stringify(HTML)}`);

            // 5. Turn off: the record is deleted at once, the plain preview and the offer come back, nothing runs
            await open(); await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-bar')`, `${w}: on`, 10000);
            await click('.artifact-scripts-off');
            await waitFor(`!document.querySelector('#artifact-viewer .artifact-scripts-bar') && !!document.querySelector('#artifact-viewer .artifact-scripts-ask')`, `${w}: Turn off`, 10000);
            assert.equal(await ev(`window.__trust.has(${JSON.stringify(HEX)})`), false, `${w}: the trust is deleted`);
            assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-linked-preview iframe').getAttribute('sandbox')`), '', `${w}: the plain frame is back`);
            assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-sandbox').hidden`), false, `${w}: the Sandboxed chip is back with the plain banner`);
            assert.equal(await frameText(true), null, `${w}: no host frame is left running`);

            // 6. fail closed: a trust that cannot be read, even for a digest that IS trusted, leaves scripts off
            await ev(`window.__trust.add(${JSON.stringify(HEX)}); window.__trustMode = 'fail'`);
            await open(); await sleep(600); // sleep-ok: a negative: scripts would be drawn by now
            assert.ok(!(await q('.artifact-scripts-bar')), `${w}: a failed trust read means no scripts`);
            assert.equal(await frameText(true), null, `${w}: and no host frame`);
            await ev(`window.__trustMode = 'ok'`);

            // 7. the bytes are not the trusted digest (a file changed under its name, or a swapped response): off, with the reason
            await ev(`window.__body = '<p id="o">swapped</p><script>1<\\/script>'`);
            await open(); await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-line')`, `${w}: the hash line`, 10000);
            assert.ok(/could not check that this is the version you trusted/.test(await text('.artifact-scripts-line')) && !(await q('.artifact-scripts-bar')), `${w}: a mismatched hash leaves scripts off and says why`);
            assert.equal(await frameText(true), null, `${w}: no host frame for a mismatched hash`);
            await shot('scripts-mismatch-' + w);

            // 8. over 2 MiB (the preview's own limit, the same number): no frame and no offer
            await ev(`window.__trust.clear(); window.__body = '<p>' + 'x'.repeat(2 * 1024 * 1024 + 10) + '</p>'`);
            await open(HEX, false); await sleep(800); // sleep-ok: a negative: the over-limit file is answered by the preview's own fallback, which never draws a frame or an offer
            const big = await ev(`({ line: (document.querySelector('#artifact-viewer .artifact-scripts-line') || {}).textContent || '', ask: !!document.querySelector('#artifact-viewer .artifact-scripts-ask'), frame: !!document.querySelector('#artifact-viewer .artifact-linked-preview iframe') })`);
            assert.ok(!big.ask, `${w}: a file over 2 MiB is not offered scripts: ` + JSON.stringify(big).slice(0, 200));
            await ev(`window.__body = ${JSON.stringify(HTML)}; document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
        }
    } finally { await client.close(); }
    console.log('artifact_scripts_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
