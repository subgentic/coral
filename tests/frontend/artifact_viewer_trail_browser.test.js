// A link inside a document in the viewer opens the linked file as a step, with a way back (#18208, the Operator: "no way back to the document in review"): 'Back to <document>' returns to the same document at
// the same scroll with its Approve / Request changes, and Escape and the browser's Back return too. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const A = 'a'.repeat(64), B = 'b'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => {
                const R = window.fetch; window.__errs = []; addEventListener('error', e => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason && e.reason.stack || e.reason)));
                const doc = '# The plan\\n\\n' + Array.from({ length: 90 }, (_, i) => 'Paragraph ' + i + ' of the plan, long enough to take a line or two on a phone.').join('\\n\\n') + '\\n\\nSee [the shot](coral://artifacts/${B}).';
                window.fetch = (url, opts = {}) => {
                    const u = new URL(String(url), location.origin), m = /^\\/api\\/artifacts\\/([0-9a-f]{64})(?:\\/content)?$/.exec(u.pathname);
                    if (!m) return R(url, opts);
                    return Promise.resolve(new Response(m[1] === '${A}' ? doc : 'the linked file', { headers: { 'Content-Type': 'text/' + (m[1] === '${A}' ? 'markdown' : 'plain') } })); };
                return true; })()`);
            await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m => { m.openArtifactViewer('${A}', { server: 'local', filename: 'plan.md', mediaType: 'text/markdown' }); return true; })`);
            const title = () => ev(`document.querySelector('#artifact-viewer .artifact-viewer-title-name')?.textContent || ''`);
            const shown = () => ev(`!!document.querySelector('#artifact-viewer:not([hidden])')`);
            const back = () => ev(`(() => { const r = document.querySelector('#artifact-viewer .artifact-viewer-trail'); return r && !r.hidden ? r.textContent.trim() : ''; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown a.mb-artifact-ref')`, at + 'the document is drawn with its link', 10000);
            assert.equal(await back(), '', at + 'a document opened by itself has no Back');
            const scroller = `(() => { const d = document.querySelector('#artifact-viewer'); return [d.querySelector('.artifact-viewer-body'), d.querySelector('.artifact-viewer-main'), d.querySelector('.artifact-viewer-content')].find(e => e && e.scrollHeight > e.clientHeight + 50); })()`;
            const top = await ev(`(() => { const s = ${scroller}; if (!s) return -1; s.scrollTop = 600; return s.scrollTop; })()`);
            assert.ok(top > 300, at + 'the document scrolls and was scrolled: ' + top);
            const link = async () => { await ev(`document.querySelector('#artifact-viewer .artifact-viewer-markdown a.mb-artifact-ref').click(); true`); };
            const backToDoc = async how => {
                await how();
                await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-title-name')?.textContent === 'plan.md' && !!document.querySelector('#artifact-viewer .artifact-viewer-markdown a.mb-artifact-ref')`, at + 'back at the document', 8000, `({ t: document.querySelector('#artifact-viewer .artifact-viewer-title')?.textContent, body: document.querySelector('#artifact-viewer .artifact-viewer-body').textContent.slice(0, 60), trail: document.querySelector('#artifact-viewer .artifact-viewer-trail').textContent, errs: window.__errs, hs: history.state, hidden: document.querySelector('#artifact-viewer').hidden, html: document.querySelector('#artifact-viewer .artifact-viewer-body').innerHTML.length })`);
                assert.equal(await back(), '', at + 'no Back at the document itself');
                return ev(`(() => { const s = ${scroller}; return s ? s.scrollTop : -1; })()`);
            };
            // 1 the Back button
            await link();
            await waitFor(`/linked file/.test(document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent || '')`, at + 'the linked file is in the same viewer', 8000);
            assert.ok(await shown(), at + 'the viewer stays open');
            assert.equal(await back(), 'Back to plan.md', at + 'the way back names the document: ' + await back());
            const bb = await ev(`(() => { const r = document.querySelector('#artifact-viewer .artifact-viewer-back').getBoundingClientRect(); return { h: Math.round(r.height), on: r.top >= 0 && r.bottom <= innerHeight }; })()`);
            assert.ok(bb.on && (!mobile || bb.h >= 40), at + 'the Back button is on screen' + (mobile ? ' and a phone target' : '') + ': ' + JSON.stringify(bb));
            let at1 = await backToDoc(() => ev(`document.querySelector('#artifact-viewer .artifact-viewer-back').click(); true`));
            assert.ok(Math.abs(at1 - top) <= 2, at + 'Back returns to the same scroll: ' + at1 + ' vs ' + top);
            // 2 Escape goes back first, and closes the viewer the second time
            await link(); await waitFor(`/linked file/.test(document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent || '')`, at + 'again the linked file', 8000);
            at1 = await backToDoc(() => ev(`document.querySelector('#artifact-viewer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`));
            assert.ok(Math.abs(at1 - top) <= 2, at + 'Escape returns to the same scroll: ' + at1);
            assert.ok(await shown(), at + 'the first Escape did not close the viewer');
            await ev(`document.querySelector('#artifact-viewer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            await waitFor(`!document.querySelector('#artifact-viewer:not([hidden])')`, at + 'the second Escape closes it', 5000);
            // 3 the browser's Back
            await ev(`import((window.__coralStatic||'/static/')+'artifact_viewer.js').then(m => { m.openArtifactViewer('${A}', { server: 'local', filename: 'plan.md', mediaType: 'text/markdown' }); return true; })`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown a.mb-artifact-ref')`, at + 'the document is drawn again', 10000);
            await link(); await waitFor(`/linked file/.test(document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent || '')`, at + 'the linked file again', 8000);
            await backToDoc(() => ev(`history.back(); true`));
            assert.ok(await shown(), at + "the browser's Back returned to the document, not past the viewer");
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await waitFor(`!document.querySelector('#artifact-viewer:not([hidden])')`, at + 'Close closes', 5000);
            assert.equal(await back(), '', at + 'a closed viewer holds no trail');
        }
    } catch (e) { failures.push(e); }
    try { client.close(); } catch { /* closing */ }
    if (failures.length) { for (const f of failures) console.error(f && f.stack || f); process.exit(1); }
    console.log('artifact_viewer_trail_browser: ok');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
