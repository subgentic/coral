// Approve with a comment still unsent (#16399, the Beta Tester's re-walk #16383): the viewer's Approve does not go through silently while a comment is typed and not sent: the first press says so and focuses the box,
// the second approves without it; with nothing typed one press approves. A fake comment box stands in for the comments panel (the guard reads the box in the viewer). 1280 and 390 px.
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
            const box = () => ev(`(() => { const d = document.querySelector('.artifact-viewer-content') || document.getElementById('artifact-viewer'); let f = d.querySelector('.ac-composer'); if (!f) { f = document.createElement('form'); f.className = 'ac-composer'; const t = document.createElement('textarea'); t.className = 'field ac-input'; f.append(t); d.append(f); } return true; })()`);
            const type = text => ev(`(() => { const t = document.querySelector('.ac-composer .ac-input'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const posts = () => ev(`(window.__posts || []).length`);
            await box(); await type('Is the date right?');
            await ev(`document.querySelector('.artifact-review-approve').click(); true`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: an approval that wrongly went through would have posted by now
            check(`${w}: Approve with an unsent comment does not approve at once`, (await posts()) === 0, 'posts ' + await posts());
            check(`${w}: and the comment box has the focus`, await ev(`document.activeElement === document.querySelector('.ac-composer .ac-input')`), 'focus elsewhere');
            await ev(`document.querySelector('.artifact-review-approve').click(); true`);
            await waitFor(`(window.__posts || []).length > 0`, 'the second press approves', 5000);
            check(`${w}: the second press approves without the comment`, (await posts()) === 1 && (await ev(`window.__posts[0].decision`)) === 'approve', JSON.stringify(await ev('window.__posts')));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('review_unsent_comment_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
