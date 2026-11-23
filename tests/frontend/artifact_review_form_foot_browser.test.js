// #20736 (the Operator, from a phone: "confusing on the phone, multiple approve request buttons"): after Request changes the note form shows Send request / Approve with comment / Cancel, and the viewer's
// bottom bar (Approve / Request changes / Close) used to sit under it too: two sets of Approve. While the form is open the bar is hidden and the form's three buttons are the only actions; Cancel brings the bar back.
// 390 px with touch and 1280 px, the routes stubbed (artifact_versions_stub).
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
            const approves = () => ev(`[...document.querySelectorAll('.artifact-viewer button')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && /^approve/i.test(b.textContent.trim())).map(b => b.textContent.trim())`);
            const foot = () => ev(`(f => getComputedStyle(f).display !== 'none' && f.getClientRects().length > 0)(document.querySelector('.artifact-viewer-foot'))`);
            if (mobile) {
                assert.equal(await foot(), true, `${w}: the bottom bar shows before the form opens`);
                assert.deepEqual(await approves(), ['Approve'], `${w}: one Approve before the form opens`);
            }
            await shot(`form-closed-${w}`);
            await ev(`document.querySelector('.artifact-review-changes').click(); true`);
            await waitFor(`!document.querySelector('.artifact-review-form').hidden`, `${w}: the change-request form opens`, 4000);
            await ev(framesJs(3));
            await shot(`form-open-${w}`);
            assert.equal(await foot(), !mobile, `${w}: ${mobile ? 'the bottom bar is hidden while the note form is open' : 'the desktop bar (only Close) is unchanged'}`);
            const open = await approves();
            assert.deepEqual(open, mobile ? ['Approve with comment'] : ['Approve', 'Approve with comment'], `${w}: ${mobile ? 'the form' + "'" + 's Approve with comment is the only Approve control on a phone' : 'the header keeps its Approve beside the form (the desktop bar is unchanged)'}: ` + JSON.stringify(open));
            const btns = await ev(`[...document.querySelectorAll('.artifact-review-form button')].filter(b => b.getClientRects().length).map(b => b.textContent.trim()).filter(t => t !== 'Add image')`); // Add image is the picture picker, not a decision
            assert.deepEqual(btns.sort(), ['Approve with comment', 'Cancel', 'Send request'], `${w}: the form keeps its three buttons`);
            await ev(`document.querySelector('.artifact-review-cancel').click(); true`);
            await ev(framesJs(3));
            assert.equal(await ev(`document.querySelector('.artifact-review-form').hidden`), true, `${w}: Cancel closes the form`);
            if (mobile) assert.equal(await foot(), true, `${w}: Cancel brings the bottom bar back`);
            assert.equal(await ev(`document.querySelector('.artifact-viewer').hasAttribute('data-review-form-open')`), false, `${w}: the viewer no longer says the form is open`);
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
        }
    } finally { await client.close(); }
    console.log('artifact_review_form_foot_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
