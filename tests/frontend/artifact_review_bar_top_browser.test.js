// #20820 (the Operator on 2.1.5): the review bar of the artifact viewer (status, Comments, Approve, Request changes) was cut through the middle by the dark area above it "in some cases". Cause: the shared .modal-footer has margins of -24px at the sides and bottom, for a dialog with 24px of padding; the viewer's overflow-hidden content has none, so its footer poked 24px out and a focus or scrollIntoView (a page in the preview, a field, a button) slid the content up under its top edge, taking the header's buttons with it.
// at 390 and 1280, in review mode, with the Comments panel open and with the Request changes form open, nothing runs past either edge of the screen, the page has no sideways scroll, and the footer is not pulled out
// past the dialog (mobile.css gave it a margin of -16 px at the sides: at 390 it ran x -5 to 395 and Close sat 3 px from the edge). The routes are stubbed (artifact_versions_stub).
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
        const sizes = [[1440, 900, 1], [1440, 600, 1], [1152, 720, 1.25], [960, 600, 1.5], [1100, 1100, 1], [820, 600, 1], [390, 844, 1]]; // window sizes at 100, 125 and 150 % zoom (the CSS pixels left), heights 600 to 1100
        for (const [w, h, z] of sizes) {
            const mobile = w <= 480;
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
            await ev(framesJs(3));
            const probe = () => ev(`(() => { const c = document.querySelector('.artifact-viewer-content'), cb = c.getBoundingClientRect(); const before = c.scrollTop; c.scrollTop = 40; c.scrollLeft = 40; const moved = [c.scrollTop - before, c.scrollLeft]; c.scrollTop = before; c.scrollLeft = 0;
                const foot = document.querySelector('.artifact-viewer-foot'); if (foot) foot.scrollIntoView({ block: 'end' }); const slid = c.scrollTop + c.scrollLeft; c.scrollTop = 0; c.scrollLeft = 0;
                const bar = [...document.querySelectorAll('.artifact-viewer-header button, .artifact-viewer-header .artifact-review-state, .artifact-viewer-header .ac-toggle')].filter(e => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1).map(e => { const b = e.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 6)); return { t: (e.textContent || '').trim().slice(0, 14), above: Math.round(cb.top - b.top), covered: !!hit && !(e === hit || e.contains(hit) || hit.contains(e)) }; });
                return { over: [c.scrollHeight - c.clientHeight, c.scrollWidth - c.clientWidth], moved, slid, bar }; })()`);
            const run = async state => {
                const r = await probe(); const at = `${w}x${h} (zoom ${z}) ${state}: `;
                assert.ok(r.bar.length >= 2, at + 'the review bar has its buttons: ' + JSON.stringify(r.bar));
                assert.deepEqual(r.over, [0, 0], at + 'the viewer content holds its own children (nothing pokes out of its box, so nothing can scroll it): ' + JSON.stringify(r.over));
                assert.deepEqual(r.moved, [0, 0], at + 'the content cannot be scrolled by a script: ' + JSON.stringify(r.moved));
                assert.equal(r.slid, 0, at + 'scrolling the footer into view does not move the content');
                assert.deepEqual(r.bar.filter(b => b.above > 0.5 || b.covered), [], at + "every button's top is at or below the top of the content and nothing covers it");
            };
            await run('review');
            await ev(`document.querySelector('.artifact-review-changes').click(); true`); await ev(framesJs(3)); await run('request changes form open');
            await ev(`(() => { const p = document.querySelector('.ac-panel'); if (!(p && p.getClientRects().length > 0)) document.querySelector('.ac-toggle').click(); return true; })()`); await ev(framesJs(3)); await run('comments open');
        }
        console.log('PASS the review bar stays under the viewer top at six window sizes and three zooms');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
