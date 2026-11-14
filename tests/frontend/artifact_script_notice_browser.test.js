// #16549 (walk 24 finding 2): a pane's preview of an HTML file that draws itself with scripts looked empty ("Ingredients" with nothing under it) and said nothing about scripts. Now the banner says the page needs scripts, that they are off, and
// the way to run them (Open, then Run scripts…); a page with no script keeps its usual banner. The bytes come from a stubbed fetch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const A = 'c'.repeat(64), B = 'd'.repeat(64);
const SCRIPTED = '<!doctype html><html><body><h2>Ingredients</h2><ul id="list"></ul><script>document.getElementById("list").innerHTML="<li>Flour</li>";</script></body></html>';
const PLAIN = '<!doctype html><html><body><h2>Ingredients</h2><ul><li>Flour</li></ul></body></html>';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup');
            const tag = w + ' px';
            await ev(`(() => { const real = window.fetch; const docs = { ${JSON.stringify(A)}: ${JSON.stringify(SCRIPTED)}, ${JSON.stringify(B)}: ${JSON.stringify(PLAIN)} };
                window.fetch = (input, init) => { const u = String(input && input.url ? input.url : input); for (const k of Object.keys(docs)) if (u.includes('/api/artifacts/' + k)) return Promise.resolve(new Response(docs[k], { headers: { 'Content-Type': 'text/html' } })); return real(input, init); }; return true; })()`);
            const banner = hex => ev(`(async () => { const m = await import((window.__coralStatic||'/static/') + 'artifact_preview.js'); const host = document.createElement('div'); document.body.append(host);
                await m.renderArtifact(host, 'coral://artifacts/${hex}', { filename: 'recipe.html', mediaType: 'text/html' }, { signal: undefined, isStale: () => false, renderContent() {}, openEntry() {}, setMeta() {} });
                const n = host.querySelector('.artifact-linked-notice'); const r = n ? { text: n.textContent, cls: n.className, shown: n.checkVisibility() } : null; host.remove(); return r; })()`);
            const scripted = await banner(A);
            assert.ok(scripted && /needs scripts/.test(scripted.text) && /off in this preview/.test(scripted.text) && /Open, then Run scripts/.test(scripted.text), tag + ': a script-filled page says it needs scripts, that they are off, and how to run them: ' + JSON.stringify(scripted));
            assert.ok(scripted.shown && /notice-warn/.test(scripted.cls), tag + ': the notice is visible and a warning');
            const plain = await banner(B);
            assert.equal(plain && plain.text, 'HTML preview: scripts and external resources are disabled. Download the file for the original.', tag + ': a page with no script keeps its usual banner');
        }
        console.log('PASS a pane preview of a script-filled page says it needs scripts and how to run them');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
