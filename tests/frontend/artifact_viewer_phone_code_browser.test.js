// The file viewer on a phone with a code file (walk 11 M1 to M3, #15267): with Details showing, row one is the name and the ⋯ button, row two Details and Comments, then the chips (no button alone on a row);
// a long name in a code line wraps instead of being cut at the right edge; Add comment on a touch screen sits above the bar, not over the lines under the selection. 390 px with touch, the routes stubbed (artifact_code_stub).
// The stub is the versions stub with a JavaScript file in place of the Markdown one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_code_stub');
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
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan-for-the-whole-company-spring-launch-final-draft-reviewed-by-legal-and-the-board-of-directors-and-the-press-office-version-three-of-three.js', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])') && !!document.querySelector('.av-current')`, `${w}: the viewer shows its review and versions`, 12000);
            // the viewer moves for a few frames when the viewport or the form changes: measure when its box and the bar have stopped (the same numbers in three frames in a row)
            const settle = async () => { let last = '', same = 0; for (let i = 0; i < 60 && same < 3; i++) { await ev(framesJs(1)); const now = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return [b.top, b.bottom, b.height].map(Math.round).join(','); }; return [r(document.querySelector('.artifact-viewer')), r(document.querySelector('.artifact-viewer-foot')), r(document.querySelector('.artifact-viewer-body')), r(document.querySelector('.artifact-review'))].join('|'); })()`); same = now === last ? same + 1 : 0; last = now; } };
            const m = () => ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), r = e => e && e.getBoundingClientRect(), q = s => d.querySelector(s), foot = q('.artifact-viewer-foot'), body = q('.artifact-viewer-body'), head = q('.artifact-viewer-header'),
                    mid = e => r(e).top + r(e).height / 2, inFoot = e => !!e && foot.contains(e), tall = e => Math.round(r(e).height);
                return { above: Math.round(r(body).top - r(d).top), headH: Math.round(r(head).height), footTop: Math.round(r(foot).top), footBottom: Math.round(r(foot).bottom), bodyBottom: Math.round(r(body).bottom), vv: Math.round(parseFloat(getComputedStyle(document.querySelector('.artifact-viewer')).height)),
                    approveInFoot: inFoot(q('.artifact-review-approve')), changesInFoot: inFoot(q('.artifact-review-changes')), approveH: tall(q('.artifact-review-approve')), changesH: tall(q('.artifact-review-changes')), closeH: tall(q('.artifact-viewer-close')), padBottom: parseFloat(getComputedStyle(foot).paddingBottom),
                    titleTop: Math.round(mid(q('.artifact-viewer-title'))), moreTop: Math.round(mid(q('.artifact-viewer-more'))), chipTop: Math.round(mid(q('.av-current'))), stateTop: Math.round(mid(q('.artifact-review-state'))), commentsTop: Math.round(mid(q('.ac-toggle'))),
                    inChips: { toggle: !!q('.artifact-viewer-chips .ac-toggle'), state: !!q('.artifact-viewer-chips .artifact-review-state') } }; })()`);
            // (the Details button shows once a goal, a task or who can read is known: the stub has none, so the suite shows it)
            await ev(`(() => { const b = document.querySelector('.artifact-viewer-details'); if (b) { b.hidden = false; b.setAttribute('aria-expanded', 'true'); } return true; })()`); // on a phone Details is an item of the ⋯ menu and its button shows only while Details is open (#15033), so open it: the row-two layout is for that state
            await settle(); await shot('viewer-phone-code-' + w);
            const g = await ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), q = s => d.querySelector(s), r = e => e.getBoundingClientRect(), mid = e => Math.round(r(e).top + r(e).height / 2), pre = q('pre.artifact-viewer-text');
                return { titleTop: mid(q('.artifact-viewer-title')), moreTop: mid(q('.artifact-viewer-more')), detailsTop: mid(q('.artifact-viewer-details')), commentsTop: mid(q('.ac-toggle')), chipTop: mid(q('.av-current')), titleW: Math.round(r(q('.artifact-viewer-title')).width), detailsW: Math.round(r(q('.artifact-viewer-details')).width), commentsW: Math.round(r(q('.ac-toggle')).width), preScroll: pre.scrollWidth, preClient: pre.clientWidth, wrap: getComputedStyle(pre).overflowWrap }; })()`);
            console.log('   ' + JSON.stringify(g));
            assert.ok(Math.abs(g.titleTop - g.moreTop) <= 8, 'row one is the name and the ⋯ button: ' + JSON.stringify(g));
            assert.ok(Math.abs(g.detailsTop - g.commentsTop) <= 8 && g.detailsTop > g.titleTop + 10, 'Details and Comments share row two, not a button alone on a row: ' + JSON.stringify(g));
            assert.ok(g.chipTop > g.detailsTop + 10, 'the version chips are under them: ' + JSON.stringify(g));
            assert.ok(g.titleW >= 250, 'the name has the width of the row beside the ⋯ button: ' + g.titleW);
            assert.ok(g.detailsW >= 44 && g.commentsW >= 44, 'both are touch targets: ' + JSON.stringify([g.detailsW, g.commentsW]));
            assert.ok(g.preScroll <= g.preClient + 1, `a code line wraps at the edge, a long name in it too (it was cut at the right edge): the text is ${g.preScroll} px in a ${g.preClient} px box`);
            // Add comment on a touch screen is not over the lines under the selection (walk 11 M3): it sits above the bar on the right
            await ev(`(() => { const code = document.querySelector('pre.artifact-viewer-text code'), r = document.createRange(), n = code.firstChild; r.setStart(n, 0); r.setEnd(n, 20); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); return true; })()`);
            await waitFor(`!document.querySelector('.ac-selbtn').hidden`, `${w}: Add comment shows for a selection`, 4000);
            const b = await ev(`(() => { const s = document.querySelector('.ac-selbtn').getBoundingClientRect(), sel = getSelection().getRangeAt(0).getBoundingClientRect(), foot = document.querySelector('.artifact-viewer-foot').getBoundingClientRect(); return { top: Math.round(s.top), bottom: Math.round(s.bottom), left: Math.round(s.left), selBottom: Math.round(sel.bottom), footTop: Math.round(foot.top), h: Math.round(s.height) }; })()`);
            await shot('viewer-phone-add-comment-' + w);
            assert.ok(b.bottom <= b.footTop, 'Add comment is above the bar: ' + JSON.stringify(b));
            assert.ok(b.top > b.selBottom + 40, 'Add comment is not on the lines under the selection (it was 6 px under them): ' + JSON.stringify(b));
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
