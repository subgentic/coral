// (#15545) The review form is ONE calm place under the toolbar: one comment box that goes with Approve (the comment is the approval's note) or with Request changes, Cancel, the request and Approve with comment side by side, right-aligned, normal size; the title and version controls stay put. 1280 and 390 px.
// (older header text) The file viewer's controls are ONE row (#12223, slice a of the compact viewer the operator approved, design 112a22a4): the name, the version chip ("v3 of 3" with its Previous and Next), the review's status, Comments, Approve and
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
    const failures = []; const check = (name, ok, extra) => { if (!ok) failures.push(name + ': ' + extra); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 800, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
                if (/\\/api\\/team-artifacts/.test(url)) return Promise.resolve(new Response(JSON.stringify(window.__reviewFixturePage(u, location.origin, { 'team-a': [{ id: '${H3}', name: 'release-plan.md', available:true,tags: ['for review'], produced_by: 'Writer A', media_type: 'text/markdown', size: 12000, created_at: new Date().toISOString() }] })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/review/.test(url) && o && o.method === 'POST') { (window.__posts = window.__posts || []).push(JSON.parse(o.body)); } if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/review/.test(url) && o && o.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ state: 'approved', changed: true, tags: ['approved'], review: { state: 'approved', at: new Date().toISOString() }, delivered: true, to: 'Writer A' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(url) && o && o.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ tags: ['for review', 'read'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); // opening a for-review file marks it read (#9277)
                return orig(u, o); }; return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { goal: 'Ship it', goalId: 3, goalTeam: 'team-a', task: 'A task', filename: 'release-plan-for-the-whole-company-spring-launch-final-draft-reviewed-by-legal-and-the-board-of-directors-and-the-press-office-version-three-of-three.md', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
            const rects = () => ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; }; const q = s => d.querySelector(s); return { title: r(q('.artifact-viewer-title')), chip: r(q('.av-current')), approve: r(q('.artifact-review-approve')), changes: r(q('.artifact-review-changes')) }; })()`);
            await waitFor(`!!document.querySelector('.artifact-review-changes:not([hidden])') && !!document.querySelector('.artifact-viewer-title') && !!document.querySelector('.av-current')`, 'the review controls show', 8000);
            const before = await rects();
            await ev(`document.querySelector('.artifact-review-changes').click(); true`);
            await waitFor(`(() => { const f = document.querySelector('.artifact-review-form:not([hidden])'); return !!f && f.getBoundingClientRect().height > 0; })()`, 'the form opens', 5000);
            const after = await rects();
            check(`${w}: opening the form leaves the title and the version controls where they were`, JSON.stringify(before.title) === JSON.stringify(after.title) && JSON.stringify(before.chip) === JSON.stringify(after.chip), JSON.stringify({ before, after }));
            const g = await ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; }; const q = s => d.querySelector(s), f = q('.artifact-review-form'), ap = f.querySelector('.artifact-review-approve-note'), send = f.querySelector('button[type=submit]'), cancel = f.querySelector('.artifact-review-cancel'), tb = q('.artifact-review-changes'); return { form: r(f), ap: r(ap), apText: ap && ap.textContent, send: r(send), cancel: r(cancel), tb: r(tb), body: r(q('.artifact-viewer-body')), hidden: ap ? getComputedStyle(ap).visibility : null }; })()`);
            await shot('rc-' + w);
            check(`${w}: the form has an Approve with comment button`, !!g.ap && /^Approve with comment$/.test(g.apText), JSON.stringify(g));
            if (g.ap) {
                check(`${w}: the request button and Approve with comment are side by side, one row` + (w > 768 ? ' with Cancel' : ', Cancel under them'), g.ap.t === g.send.t && (w > 768 ? g.send.t === g.cancel.t : g.cancel.t >= g.send.b - 1), JSON.stringify(g));
                check(`${w}: they are right-aligned and at normal size (as tall as the toolbar's buttons)`, g.ap.r >= g.form.r - 20 && g.ap.h >= g.tb.h - 2 && g.send.h >= g.tb.h - 2, JSON.stringify(g));
                if (w > 768) check(`${w}: the form is below the toolbar`, g.form.t >= Math.max(before.approve.b, before.changes.b) - 1, JSON.stringify(g)); /* on a phone the toolbar is the footer */
                // in the Request changes form the one primary is Send request: an accidental Enter or tap must not approve (#16909, walk 41 F2)
                const prim = await ev(`({ send: document.querySelector('.artifact-review-form button[type=submit]').classList.contains('btn-primary'), approve: document.querySelector('.artifact-review-form .artifact-review-approve-note').classList.contains('btn-primary') })`);
                check(`${w}: Send request is the form's primary and Approve with comment is not`, prim.send && !prim.approve, JSON.stringify(prim));
                await ev(`(() => { const t = document.getElementById('artifact-review-text'); t.value = 'Almost: fix the date.'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await ev(`document.querySelector('.artifact-review-form .artifact-review-approve-note').click(); true`);
                await waitFor(`(window.__posts || []).length > 0`, 'the approval is sent', 5000);
                const posts = await ev(`window.__posts`);
                check(`${w}: Approve with comment approves and sends the comment as the note`, posts.length === 1 && posts[0].decision === 'approve' && posts[0].note === 'Almost: fix the date.', JSON.stringify(posts));
            }
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('review_approve_comment_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
