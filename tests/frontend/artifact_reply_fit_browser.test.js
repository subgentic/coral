// #15231 (walk 8 M3): a reply box opened in the comments panel is inside the panel's visible area (not under the dialog's footer), and says how to send: Enter starts a new line, Ctrl+Enter sends. 1024 x 700 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1024, 700, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(H3)}, { filename: 'release-plan.md' }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .ac-toggle')`, at + 'the viewer has Comments', 12000);
            await ev(`(() => { const p = document.querySelector('#artifact-viewer .ac-panel'); if (!p || p.getClientRects().length === 0) document.querySelector('#artifact-viewer .ac-toggle').click(); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .ac-replybox')`, at + 'a comment with a Reply box', 8000);
            await ev(`document.querySelector('#artifact-viewer .ac-replybox').click(); true`);
            await waitFor(`!!document.querySelector('#artifact-viewer .ac-composer .ac-input')`, at + 'the reply box opens', 5000);
            const m = await ev(`(() => { const c = document.querySelector('#artifact-viewer .ac-composer'), ta = c.querySelector('.ac-input'), hint = c.querySelector('.ac-sendhint'), panel = document.querySelector('#artifact-viewer .ac-panel'), foot = document.querySelector('#artifact-viewer .artifact-viewer-foot'), r = e => e && e.getBoundingClientRect();
                const pr = r(panel), cr = r(c), fr = foot && foot.getClientRects().length ? r(foot) : null;
                return { hint: hint ? hint.textContent : null, described: !!hint && ta.getAttribute('aria-describedby') === hint.id, cTop: Math.round(cr.top), cBottom: Math.round(cr.bottom), pTop: Math.round(pr.top), pBottom: Math.round(pr.bottom), fTop: fr ? Math.round(fr.top) : null }; })()`);
            console.log(at + JSON.stringify(m));
            assert.ok(m.hint && /Enter/.test(m.hint) && /Ctrl/.test(m.hint) && m.described, at + 'it says how to send, and the box is described by it: ' + JSON.stringify(m));
            assert.ok(m.cTop >= m.pTop - 1 && m.cBottom <= m.pBottom + 1, at + 'the reply box is inside the panel: ' + JSON.stringify(m));
            const hit = await ev(`(() => { const out = {}; for (const k of ['.ac-input', '.ac-send', '.ac-cancel']) { const e = document.querySelector('#artifact-viewer .ac-composer ' + k), b = e.getBoundingClientRect(), t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); out[k] = t === e || e.contains(t); } return out; })()`);
            assert.ok(hit['.ac-input'] && hit['.ac-send'] && hit['.ac-cancel'], at + 'the box, Reply and Cancel are what a finger reaches (nothing, such as the footer, is over them): ' + JSON.stringify(hit));
        }
    } finally { await client.close(); }
    console.log('artifact_reply_fit_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
