// #11243 (the operator's shot of an HTML artifact opened from Inbox > Needs you): the artifact viewer dialog is one dialog for every entry point (Needs you, the Artifacts page, a goal's Artifacts tab, Knowledge: they all call
// openArtifactViewer), and with an HTML preview it was a small frame above a footer band about 100 px tall that held only Close. The frame is most of the dialog (at least 75% of its height) and the footer is a slim bar (no taller
// than 56 px). At 1440x900 and a 390x844 phone. The bytes come from a stubbed fetch (as artifact_html_preview_fills does).
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const HEX = 'c'.repeat(64);
const DOC = '<!doctype html><html><body><h1>Goals post draft</h1>' + Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1} of the draft.</p>`).join('') + '</body></html>';

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic||'/static/')`;
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const tag = mobile ? 'phone' : 'desktop';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired();
            await coralReady();
            await ev(`(() => { const real = window.fetch; window.fetch = (input, init) => { const u = String(input && input.url ? input.url : input); if (u.includes('/api/artifacts/' + ${JSON.stringify(HEX)})) return Promise.resolve(new Response(${JSON.stringify(DOC)}, { headers: { 'Content-Type': 'text/html' } })); return real(input, init); }; return true; })()`);
            await ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'goals-post-draft-review.html', mediaType: 'text/html' }))`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body iframe')`, 'the frame');
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the dialog's layout settles once the frame is in
            const g = await ev(`(() => { const d = document.getElementById('artifact-viewer'), c = d.querySelector('.artifact-viewer-content').getBoundingClientRect(), f = d.querySelector('.artifact-viewer-body iframe').getBoundingClientRect(), foot = d.querySelector('.artifact-viewer-foot').getBoundingClientRect(), close = d.querySelector('.artifact-viewer-close');
                return { frameB: Math.round(f.bottom), footT: Math.round(foot.top), footB: Math.round(foot.bottom), contentB: Math.round(c.bottom), dialogH: Math.round(c.height), frameH: Math.round(f.height), footH: Math.round(foot.height), closeH: Math.round(close.getBoundingClientRect().height), closeShown: close.getClientRects().length > 0, vh: innerHeight }; })()`);
            assert.ok(g.frameH >= g.dialogH * 0.75, `${tag}: the frame is at least 75% of the dialog's height: ${JSON.stringify(g)}`);
            assert.ok(g.footH <= 56, `${tag}: the footer band is no taller than 56 px: ${JSON.stringify(g)}`);
            assert.ok(g.frameB <= g.footT + 1, `${tag}: the footer does not cover the frame's last pixels (frame bottom ${g.frameB}, footer top ${g.footT})`);
            if (mobile) assert.ok(g.contentB - g.footB <= 1, `${tag}: no strip of dialog under the footer (${g.contentB - g.footB} px)`);
            assert.ok(g.closeShown && g.closeH >= (mobile ? 44 : 28), `${tag}: Close is still there, and a target (${g.closeH} px)`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click()`);
        }
        console.log('PASS artifact viewer: the frame fills the dialog and the footer is a slim bar');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
