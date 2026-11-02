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
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=for%20review/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [{ id: '${H3}', name: 'release-plan.md', tags: ['for review'], produced_by: 'Writer A', media_type: 'text/markdown', size: 12000, created_at: new Date().toISOString() }], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return orig(u, o); }; return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])') && !!document.querySelector('.av-current')`, `${w}: the viewer shows its review and versions`, 12000);
            const g = await ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), head = d.querySelector('.artifact-viewer-header'), body = d.querySelector('.artifact-viewer-body'), r = e => e && e.getBoundingClientRect(), top = e => { const b = r(e); return b && b.width ? Math.round(b.top + b.height / 2) : null; };
                const q = s => d.querySelector(s), inHead = e => !!e && head.contains(e), vis = e => !!e && !!e.getClientRects().length;
                return { above: Math.round(r(body).top - r(d).top), headH: Math.round(r(head).height), headRows: new Set([q('.artifact-viewer-title'), q('.av-current'), q('.artifact-review-state'), q('.artifact-review-approve'), q('.artifact-review-changes'), q('.artifact-viewer-more')].filter(vis).map(e => Math.round(top(e) / 24))).size,
                    inHead: { chip: inHead(q('.av-current')), state: inHead(q('.artifact-review-state')), approve: inHead(q('.artifact-review-approve')), changes: inHead(q('.artifact-review-changes')), more: inHead(q('.artifact-viewer-more')) },
                    visibleAtRest: { newtab: vis(q('.artifact-viewer-newtab')), download: vis(q('.artifact-viewer-download')), note: vis(q('.artifact-review-note')), compare: vis(q('.av-compare')), details: vis(q('.artifact-viewer-readers-toggle, .details-toggle')) },
                    rows: { versionBar: vis(q('.av-bar')) && !inHead(q('.av-bar')), reviewBar: vis(q('.artifact-review')) && !inHead(q('.artifact-review')) } }; })()`);
            heights[w] = g.above; console.log(`   ${w}: controls above the file ${g.above} px (header ${g.headH} px, ${g.headRows} line(s))`);
            await shot('viewer-header-' + w);
            assert.ok(await ev(`(() => { const d = document.querySelector('.artifact-viewer-content').getBoundingClientRect(); return [...document.querySelectorAll('.artifact-viewer-header .btn, .artifact-viewer-header .chip')].filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return r.left >= d.left - 1 && r.right <= d.right + 1; }); })()`), `${w}: every control of the header is inside the viewer (none is cut off at the edge)`);
            assert.ok(g.inHead.chip && g.inHead.state && g.inHead.approve && g.inHead.changes && g.inHead.more, `${w}: the version chip, the status, Approve, Request changes and the ⋯ button are all in the header row: ` + JSON.stringify(g.inHead));
            assert.ok(!g.rows.versionBar && !g.rows.reviewBar, `${w}: no separate version bar or review bar row: ` + JSON.stringify(g.rows));
            assert.ok(!g.visibleAtRest.newtab && !g.visibleAtRest.download && !g.visibleAtRest.note && !g.visibleAtRest.compare, `${w}: Open in new tab, Download, Approve with a note and Compare are in menus, not on the row: ` + JSON.stringify(g.visibleAtRest));
            assert.ok(w === 390 ? g.headRows <= 4 : g.headRows === 1, `${w}: the controls are on ${w === 390 ? 'at most four short lines (slice d makes the phone two plus a bottom bar)' : 'one line'}: ${g.headRows}`);
            assert.ok(g.above <= (w === 390 ? 230 : 110), `${w}: the controls above the file take at most ${w === 390 ? 230 : 110} px (they take ${g.above}; before: 168 at 1280 and 379 at 390): the from line and the header`);
            // the ⋯ menu
            await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
            await waitFor(`!!document.querySelector('.artifact-viewer-menu:not([hidden])')`, `${w}: the ⋯ menu opens`, 4000);
            const items = await ev(`[...document.querySelectorAll('.artifact-viewer-menu [role=menuitem]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`);
            assert.deepEqual(items.filter(t => t !== 'Details'), ['Approve with a note', 'Open in new tab', 'Download'], `${w}: the ⋯ menu holds the less used (and Details when the file has facts to show): ` + JSON.stringify(items));
            await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
            // the version list holds Compare
            await ev(`document.querySelector('.av-current').click(); true`);
            await waitFor(`!!document.querySelector('.av-list:not([hidden])')`, `${w}: the version list opens`, 4000);
            assert.ok(await ev(`!!document.querySelector('.av-compare') && document.querySelector('.av-compare').getClientRects().length > 0 && document.querySelector('.av-compare').textContent.includes('Compare with v2')`), `${w}: Compare with v2 is in the version list`);
            await ev(`document.querySelector('.av-current').click(); document.querySelector('.artifact-viewer-close').click(); true`);
        }
        console.log('   heights before/after are in the lines above: ' + JSON.stringify(heights));
    } finally { await client.close(); }
    console.log('artifact_viewer_header_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
