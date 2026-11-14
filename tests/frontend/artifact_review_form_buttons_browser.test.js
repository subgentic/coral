// While the change-request form is open, the viewer offers one Approve and every button is whole (walk 47, #17032): the footer's Approve went away under the form's own "Approve with comment", and the form's third button was clipped by the scroll area.
// 390 px; the routes are stubbed (artifact_versions_stub).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const heights = {};
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
                if (/\\/api\\/team-artifacts/.test(url)) return Promise.resolve(new Response(JSON.stringify(window.__reviewFixturePage(u, location.origin, { 'team-a': [{ id: '${H3}', name: 'release-plan.md', available:true,tags: ['for review'], produced_by: 'Writer A', media_type: 'text/markdown', size: 12000, created_at: new Date().toISOString() }] })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/review/.test(url) && o && o.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ state: 'approved', changed: true, tags: ['approved'], review: { state: 'approved', at: new Date().toISOString() }, delivered: true, to: 'Writer A' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return orig(u, o); }; return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan-for-the-whole-company-spring-launch-final-draft-reviewed-by-legal-and-the-board-of-directors-and-the-press-office-version-three-of-three.md', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])') && !!document.querySelector('.av-current')`, `${w}: the viewer shows its review and versions`, 12000);
            await ev(`document.querySelector('.artifact-review-changes').click(); true`);
            await waitFor(`!document.querySelector('.artifact-review-form').hidden`, `${w}: the change-request form opens`, 4000);
            await ev(framesJs(4));
            const m = await ev(`(() => { const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden', scroller = document.querySelector('.artifact-review'), sr = scroller.getBoundingClientRect();
                const btns = [...document.querySelectorAll('.artifact-viewer-foot button, .artifact-review-form button')].filter(vis).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), clipped: b.closest('.artifact-review-form') ? r.bottom > sr.bottom + 1 || r.top < sr.top - 1 : false }; });
                return { btns, approves: btns.filter(b => /^Approve/.test(b.t)).length, scroller: [Math.round(sr.top), Math.round(sr.bottom)] }; })()`);
            await shot('viewer-form-open-' + w);
            assert.equal(m.approves, 1, `${w}: one Approve button while the form is open: ` + JSON.stringify(m));
            assert.deepEqual(m.btns.filter(b => b.clipped), [], `${w}: no button of the form is clipped by its scroll area: ` + JSON.stringify(m));
        }
        console.log('PASS the request-changes form has one Approve and no clipped button');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
