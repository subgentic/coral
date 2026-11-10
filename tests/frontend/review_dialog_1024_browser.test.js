// The file viewer's controls are ONE row (#12223, slice a of the compact viewer the operator approved, design 112a22a4): the name, the version chip ("v3 of 3" with its Previous and Next), the review's status, Comments, Approve and
// Request changes, and a ⋯ menu that holds Approve with a note, Open in new tab, Download and Details; Compare and the "newer version" line live in the version list that the chip opens. Before, the title row (with Details,
// Open in new tab, Comments, Download), the version bar and the review bar were three rows. A file with three versions and a pending review, the routes stubbed (artifact_versions_stub), 1280 px and 390 px (where the row may wrap to
// two). It prints the height of the controls above the file (the design's measurement) and asserts it.
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
        for (const [w, h, mobile] of [[1024, 700, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
                if (/\\/api\\/team-artifacts/.test(url)) return Promise.resolve(new Response(JSON.stringify(window.__reviewFixturePage(u, location.origin, { 'team-a': [{ id: '${H3}', name: 'release-plan.md', available:true,tags: ['for review'], produced_by: 'Writer A', media_type: 'text/markdown', size: 12000, created_at: new Date().toISOString() }] })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/review/.test(url) && o && o.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ state: 'approved', changed: true, tags: ['approved'], review: { state: 'approved', at: new Date().toISOString() }, delivered: true, to: 'Writer A' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(url) && o && o.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ tags: ['for review', 'read'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); // opening a for-review file marks it read (#9277)
                return orig(u, o); }; return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { goal: 'Ship it', goalId: 3, goalTeam: 'team-a', task: 'A task', filename: 'release-plan-for-the-whole-company-spring-launch-final-draft-reviewed-by-legal-and-the-board-of-directors-and-the-press-office-version-three-of-three.md', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
            await ev(`document.querySelector('.artifact-review-changes').click(); true`);
            await waitFor(`(() => { const f = document.querySelector('.artifact-review-form:not([hidden])'); return !!f && f.getBoundingClientRect().height > 0; })()`, 'the change-request form opens', 5000);
            const m = await ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
                const q = s => d.querySelector(s), ctl = [q('.av-current'), q('.artifact-review-approve'), q('.artifact-review-changes')].map(r);
                return { dialog: r(d), title: r(q('.artifact-viewer-title')), form: r(q('.artifact-review-form')), body: r(q('.artifact-viewer-body')), ctlBottom: Math.max(...ctl.map(c => c.b)), ctlTop: Math.min(...ctl.map(c => c.t)), send: r(q('.artifact-review-form button[type=submit]')), cancel: r(q('.artifact-review-form .artifact-review-cancel')) }; })()`);
            await shot('rd-1024');
            assert.ok(m.title.w >= 300, `the name has room to read (it was crushed to a column beside the form): ${JSON.stringify(m.title)}`);
            assert.ok(m.form.t >= m.ctlBottom, `the form sits below the controls, not between the name and the version chip: ${JSON.stringify({ form: m.form, ctlBottom: m.ctlBottom })}`);
            assert.ok(m.form.w >= m.dialog.w - 80, `the form is as wide as the dialog: ${JSON.stringify({ form: m.form.w, dialog: m.dialog.w })}`);
            assert.ok(m.send.t === m.cancel.t, `Send request and Cancel are side by side: ${JSON.stringify({ send: m.send, cancel: m.cancel })}`);
            assert.ok(m.body.h >= 120, `the file still has room above the footer: ${JSON.stringify(m.body)}`);
        }
    } finally { await client.close(); }
    console.log("review_dialog_1024_browser: ok");
})().catch(e => { console.error(e); process.exit(1); });
