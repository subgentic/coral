// The artifact viewer's review fits the screen on the real page (#16773, follow-up to coral-hub's b3d586477, which fixed the phone overflow with a hand-built page in pkg/frontend/chrome/artifact_review_overflow.mjs):
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
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
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
            const edges = () => ev(`(() => { const w = innerWidth, sel = ['.artifact-viewer-content', '.artifact-viewer-header', '.artifact-viewer-source', '.artifact-review', '.artifact-review-form', '.artifact-review-form button', '.artifact-viewer-foot', '.artifact-viewer-foot .btn', '.ac-panel']; const out = {}; for (const s of sel) { const es = [...document.querySelectorAll(s)].filter(e => e.getClientRects().length); if (!es.length) continue; out[s] = [Math.round(Math.min(...es.map(e => e.getBoundingClientRect().left)) * 10) / 10, Math.round(Math.max(...es.map(e => e.getBoundingClientRect().right)) * 10) / 10]; } return { w, scroll: document.documentElement.scrollWidth, out }; })()`);
            const check = async (state) => {
                const e = await edges(); const bad = Object.entries(e.out).filter(([, [l, r]]) => l < -0.5 || r > e.w + 0.5);
                assert.ok(e.scroll <= e.w, `${w} ${state}: no sideways scroll (${e.scroll} px of ${e.w})`);
                assert.deepEqual(bad, [], `${w} ${state}: nothing runs past an edge of the screen: ` + JSON.stringify(e.out));
                const close = e.out['.artifact-viewer-foot .btn']; if (close && w <= 479) assert.ok(close[0] >= 8 && e.w - close[1] >= 8, `${w} ${state}: the footer's buttons keep 8 px from the screen's edges: ` + JSON.stringify(close));
                await shot(`viewer-${state.replace(/ /g, '-')}-${w}`);
            };
            await check('review');
            await ev(`document.querySelector('.artifact-review-changes').click(); true`);
            await waitFor(`!document.querySelector('.artifact-review-form').hidden`, `${w}: the change-request form opens`, 4000);
            await ev(framesJs(2)); await check('request changes form open');
            await ev(`(() => { const p = document.querySelector('.ac-panel'); if (!(p && p.getClientRects().length > 0)) document.querySelector('.ac-toggle').click(); return true; })()`); /* a desktop viewer may already show the panel: a click would close it */
            await waitFor(`!!document.querySelector('.ac-panel') && document.querySelector('.ac-panel').getClientRects().length > 0`, `${w}: the Comments panel opens`, 4000);
            await ev(framesJs(2)); await check('comments open');
        }
        console.log('PASS the artifact viewer review fits at 390 and 1280');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
