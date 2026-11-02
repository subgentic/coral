// The file viewer on a phone is two thin rows and a bottom bar (#12226, slice d of the compact viewer the operator approved, design 112a22a4): row one is the name and the ⋯ menu, row two the chips (version, status, Comments);
// Approve and Request changes sit in the bar at the bottom with Close, which stays put: above the soft keyboard (the viewer follows the visual viewport), clear of the home bar (the safe area), and never over the file.
// 390 px with touch, the routes stubbed (artifact_versions_stub). It prints the height above the file and asserts it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

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
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=for%20review/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [{ id: '${H3}', name: 'release-plan.md', tags: ['for review'], produced_by: 'Writer A', media_type: 'text/markdown', size: 12000, created_at: new Date().toISOString() }], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/review/.test(url) && o && o.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ state: 'approved', changed: true, tags: ['approved'], review: { state: 'approved', at: new Date().toISOString() }, delivered: true, to: 'Writer A' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return orig(u, o); }; return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan-for-the-whole-company-spring-launch-final-draft-reviewed-by-legal-and-the-board-of-directors-and-the-press-office-version-three-of-three.md', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])') && !!document.querySelector('.av-current')`, `${w}: the viewer shows its review and versions`, 12000);
            const m = () => ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), r = e => e && e.getBoundingClientRect(), q = s => d.querySelector(s), foot = q('.artifact-viewer-foot'), body = q('.artifact-viewer-body'), head = q('.artifact-viewer-header'),
                    mid = e => r(e).top + r(e).height / 2, inFoot = e => !!e && foot.contains(e), tall = e => Math.round(r(e).height);
                return { above: Math.round(r(body).top - r(d).top), headH: Math.round(r(head).height), footTop: Math.round(r(foot).top), footBottom: Math.round(r(foot).bottom), bodyBottom: Math.round(r(body).bottom), vv: Math.round(parseFloat(getComputedStyle(document.querySelector('.artifact-viewer')).height)),
                    approveInFoot: inFoot(q('.artifact-review-approve')), changesInFoot: inFoot(q('.artifact-review-changes')), approveH: tall(q('.artifact-review-approve')), changesH: tall(q('.artifact-review-changes')), closeH: tall(q('.artifact-viewer-close')), padBottom: parseFloat(getComputedStyle(foot).paddingBottom),
                    titleTop: Math.round(mid(q('.artifact-viewer-title'))), moreTop: Math.round(mid(q('.artifact-viewer-more'))), chipTop: Math.round(mid(q('.av-current'))), stateTop: Math.round(mid(q('.artifact-review-state'))), commentsTop: Math.round(mid(q('.ac-toggle'))),
                    inChips: { toggle: !!q('.artifact-viewer-chips .ac-toggle'), state: !!q('.artifact-viewer-chips .artifact-review-state') } }; })()`);
            const g = await m(); console.log(`   ${w}: ${g.above} px above the file (header ${g.headH} px); the bar: top ${g.footTop}, bottom ${g.footBottom} of ${g.vv}`);
            await shot('viewer-phone-' + w);
            assert.ok(g.approveInFoot && g.changesInFoot, `${w}: Approve and Request changes are in the bottom bar with Close: ` + JSON.stringify(g));
            assert.ok(g.approveH >= 44 && g.changesH >= 44 && g.closeH >= 44, `${w}: the bar's buttons are 44 px targets: ` + JSON.stringify([g.approveH, g.changesH, g.closeH]));
            assert.ok(Math.abs(g.titleTop - g.moreTop) <= 8 && Math.abs(g.titleTop - g.commentsTop) <= 8, `${w}: row one is the name, Comments and the ⋯ button: ` + JSON.stringify([g.titleTop, g.commentsTop, g.moreTop]));
            assert.ok(Math.abs(g.chipTop - g.stateTop) <= 8 && g.chipTop > g.titleTop + 10, `${w}: row two is the chips (version, status), under row one: ` + JSON.stringify(g));
            assert.ok(g.headH <= 110 && g.above <= 150, `${w}: the two rows take at most 110 px and, with the question line, 150 above the file (they take ${g.headH} and ${g.above}; before slice d: 155 and 193 with this file; the design said about 96, and the rows are 44 px targets)`);
            assert.ok(g.footBottom <= g.vv + 1 && g.bodyBottom <= g.footTop + 1, `${w}: the bar is inside the screen and the file ends where it starts: ` + JSON.stringify(g));
            assert.ok(g.padBottom >= 4, `${w}: the bar keeps room for the home bar (the safe area): ` + g.padBottom);
            // the soft keyboard: the viewer follows what it leaves (--visual-viewport-height), the bar rides above it and the file still has room
            await ev(`document.documentElement.style.setProperty('--visual-viewport-height', '470px'); true`);
            await waitFor(`Math.round(document.querySelector('.artifact-viewer').getBoundingClientRect().height) === 470`, `${w}: the viewer follows the keyboard`, 4000);
            const k = await m();
            assert.ok(k.footBottom <= 471 && k.bodyBottom <= k.footTop + 1 && k.bodyBottom - (k.above) > 100, `${w}: with the keyboard up the bar is above it and the file keeps room: ` + JSON.stringify(k));
            await ev(`document.documentElement.style.removeProperty('--visual-viewport-height'); true`);
            // Request changes opens its form under the header and the bar stays
            await ev(`document.querySelector('.artifact-review-changes').click(); true`);
            await waitFor(`!document.querySelector('.artifact-review-form').hidden`, `${w}: the change-request form opens`, 4000);
            const f = await m(); assert.ok(f.approveInFoot && f.footBottom <= f.vv + 1, `${w}: the bar stays while the form is open: ` + JSON.stringify(f));
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
        }
    } finally { await client.close(); }
    console.log('artifact_viewer_phone_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
