// #18778 (beta walk rc4g): the review viewer's header does not squeeze the sender line to a clipped "D…" beside a short name (it keeps room to be read), and an Approve whose delivery
// names no agent says "The agent was told." in its toast, not "undefined was told.". The routes are stubbed (artifact_versions_stub); the approve reply is delivered:true with no `to`.
const assert = require('node:assert/strict');
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
        for (const [w, h, mobile] of [[1280, 800, false], [1024, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
                if (/\\/api\\/team-artifacts/.test(url)) return Promise.resolve(new Response(JSON.stringify(window.__reviewFixturePage(u, location.origin, { 'team-a': [{ id: '${H3}', name: 'release-plan.md', available:true,tags: ['for review'], produced_by: 'Writer A', media_type: 'text/markdown', size: 12000, created_at: new Date().toISOString() }] })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/review/.test(url) && o && o.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ state: 'approved', changed: true, tags: ['approved'], review: { state: 'approved', at: new Date().toISOString() }, delivered: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(url) && o && o.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ tags: ['for review', 'read'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); // opening a for-review file marks it read (#9277)
                return orig(u, o); }; return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { goal: 'Ship it', goalId: 3, goalTeam: 'team-a', task: 'A task', filename: 'plan.md', board: 'team-a', from: 'Developer · sample-project' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])') && !!document.querySelector('.av-current')`, `${w}: the viewer shows its review and versions`, 12000);
            const from = await ev(`(() => { const e = document.querySelector('.artifact-viewer-from'), r = e.getBoundingClientRect(); return { w: Math.round(r.width), shown: !!e.getClientRects().length, clipped: e.scrollWidth > e.clientWidth }; })()`);
            assert.ok(!from.shown || from.w >= 100, `${w}: the sender line is readable, not a clipped stub (it is ${from.w} px wide)`);
            await ev(`document.querySelector('.artifact-review-approve').click(); true`);
            await ev(`(() => { const y = document.getElementById('confirm-modal-yes'); if (y && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none') y.click(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(t => /^Approved\./.test(t.textContent))`, `${w}: Approve says it was done`, 8000);
            const toast = await ev(`[...document.querySelectorAll('.toast .toast-message')].map(t => t.textContent).find(t => /^Approved\./.test(t))`);
            assert.equal(toast, 'Approved. The agent was told.', `${w}: no agent name is no "undefined": ${toast}`);
        }
        console.log('PASS the review header keeps its sender line readable and the approve toast names no one as "The agent"');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
