// The viewer's header keeps a readable name after Request changes (#16618, walk 26 L3): the status chip then says "Changes requested: waiting for a new version from <agent>. Approving now approves this version as it is." and, one line
// and unbreakable, it crushed the name to a letter or two between 1101 px and the widest windows and ran past the dialog's edge on a narrow computer window. The chip wraps inside the room it has and the name keeps 12rem.
// The state chip takes the text a requested change gives it; 1280, 1150 and 800 px; the routes are stubbed (artifact_versions_stub).
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
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [1150, 800, false], [800, 800, false]]) {
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
            await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])') && !!document.querySelector('.av-current')`, `${w}: the viewer shows its review and versions`, 12000);

            await ev(`(() => { const s = document.querySelector('.artifact-review-state'); s.textContent = 'Changes requested: waiting for a new version from Writer A. Approving now approves this version as it is.'; s.hidden = false; return true; })()`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: layout
            const m = await ev(`(() => { const t = document.querySelector('#artifact-viewer .artifact-viewer-title'), s = document.querySelector('#artifact-viewer .artifact-review-state'), h = document.querySelector('#artifact-viewer .artifact-viewer-header'); const r = e => Math.round(e.getBoundingClientRect().width); return { title: r(t), titleText: t.textContent.slice(0, 30), state: r(s), stateH: Math.round(s.getBoundingClientRect().height), head: r(h), headH: Math.round(h.getBoundingClientRect().height), wrap: getComputedStyle(h).flexWrap }; })()`);
            const dlg = await ev(`Math.round(document.querySelector('#artifact-viewer .artifact-viewer-content').getBoundingClientRect().right)`), right = await ev(`Math.round(document.querySelector('#artifact-viewer .artifact-review-state').getBoundingClientRect().right)`);
            assert.ok(m.title >= 180, `${w}: the name keeps a readable width after Request changes (${m.title} px, ${JSON.stringify(m.titleText)}): ` + JSON.stringify(m));
            assert.ok(right <= dlg, `${w}: the status chip stays inside the dialog (right ${right}, dialog ${dlg})`);
            await shot('header-' + w);
        }
        console.log('artifact_viewer_changes_header: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
