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
                if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/review/.test(url) && o && o.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ state: 'approved', changed: true, tags: ['approved'], review: { state: 'approved', at: new Date().toISOString() }, delivered: true, to: 'Writer A' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return orig(u, o); }; return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { goal: 'Ship it', goalId: 3, goalTeam: 'team-a', task: 'A task', filename: 'release-plan-for-the-whole-company-spring-launch-final-draft-reviewed-by-legal-and-the-board-of-directors-and-the-press-office-version-three-of-three.md', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])') && !!document.querySelector('.av-current')`, `${w}: the viewer shows its review and versions`, 12000);
            const g = await ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), head = d.querySelector('.artifact-viewer-header'), body = d.querySelector('.artifact-viewer-body'), r = e => e && e.getBoundingClientRect(), top = e => { const b = r(e); return b && b.width ? Math.round(b.top + b.height / 2) : null; };
                const q = s => d.querySelector(s), inHead = e => !!e && head.contains(e), vis = e => !!e && !!e.getClientRects().length;
                return { above: Math.round(r(body).top - r(d).top), headH: Math.round(r(head).height), headRows: new Set([q('.artifact-viewer-title'), q('.av-current'), q('.artifact-review-state'), q('.artifact-review-approve'), q('.artifact-review-changes'), q('.artifact-viewer-more')].filter(vis).map(e => Math.round(top(e) / 24))).size,
                    inHead: { chip: inHead(q('.av-current')), state: inHead(q('.artifact-review-state')), approve: inHead(q('.artifact-review-approve')), changes: inHead(q('.artifact-review-changes')), more: inHead(q('.artifact-viewer-more')) },
                    visibleAtRest: { newtab: vis(q('.artifact-viewer-newtab')), download: vis(q('.artifact-viewer-download')), note: vis(q('.artifact-review-note')), compare: vis(q('.av-compare')), details: vis(q('.artifact-viewer-readers-toggle, .details-toggle')) },
                    rows: { versionBar: vis(q('.av-bar')) && !inHead(q('.av-bar')), reviewBar: vis(q('.artifact-review')) && !inHead(q('.artifact-review')) } }; })()`);
            heights[w] = g.above; console.log(`   ${w}: controls above the file ${g.above} px (header ${g.headH} px, ${g.headRows} line(s))`);
            console.log('VIEWER_GEOMETRY '+JSON.stringify(await ev(`(() => { const selectors=['.artifact-viewer-content','.artifact-viewer-header','.artifact-viewer-title','.artifact-viewer-from','.artifact-viewer-chips','.av-bar','.av-current','.artifact-review-state','.ac-toggle','.artifact-viewer-details','.artifact-viewer-more','.artifact-viewer-foot'];return {platform:navigator.platform,fonts:document.fonts.status,jakarta:document.fonts.check('14px "Plus Jakarta Sans"'),width:innerWidth,elements:selectors.map(selector=>{const e=document.querySelector(selector);if(!e)return {selector,missing:true};const s=getComputedStyle(e),r=e.getBoundingClientRect();return {selector,text:e.textContent.trim().slice(0,80),shown:!!e.getClientRects().length,font:s.font,family:s.fontFamily,size:s.fontSize,lineHeight:s.lineHeight,order:s.order,flex:s.flex,gap:s.gap,padding:s.padding,left:r.left,top:r.top,width:r.width,height:r.height};})};})()`)));
            await shot('viewer-header-' + w);
            assert.ok(await ev(`(() => { const d = document.querySelector('.artifact-viewer-content').getBoundingClientRect(); return [...document.querySelectorAll('.artifact-viewer-header .btn, .artifact-viewer-header .chip')].filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return r.left >= d.left - 1 && r.right <= d.right + 1; }); })()`), `${w}: every control of the header is inside the viewer (none is cut off at the edge)`);
            assert.ok(g.inHead.chip && g.inHead.state && (w === 390 || (g.inHead.approve && g.inHead.changes)) && g.inHead.more, // on a phone Approve and Request changes are in the bottom bar (#12226, artifact_viewer_phone_browser)
                 `${w}: the version chip, the status, Approve, Request changes and the ⋯ button are all in the header row: ` + JSON.stringify(g.inHead));
            assert.ok(!g.rows.versionBar && !g.rows.reviewBar, `${w}: no separate version bar or review bar row: ` + JSON.stringify(g.rows));
            assert.ok(!g.visibleAtRest.newtab && !g.visibleAtRest.download && !g.visibleAtRest.note && !g.visibleAtRest.compare, `${w}: Open in new tab, Download, Approve with a note and Compare are in menus, not on the row: ` + JSON.stringify(g.visibleAtRest));
            assert.ok(w === 390 ? g.headRows <= 4 : g.headRows === 1, `${w}: the controls are on ${w === 390 ? 'at most four short lines (slice d makes the phone two plus a bottom bar)' : 'one line'}: ${g.headRows}`);
            assert.ok(g.above <= (w === 390 ? 230 : 110), `${w}: the controls above the file take at most ${w === 390 ? 230 : 110} px (they take ${g.above}; before: 168 at 1280 and 379 at 390): the from line and the header`);
            // opening Details hides none of the header's other buttons, and the open box has its own Hide details at its top right (#12786)
            const names = () => ev(`[...document.querySelectorAll('.artifact-viewer-header .btn, .artifact-viewer-header button, .artifact-viewer-header .chip')].filter(e => e.getClientRects().length).map(e => (e.className.toString().split(' ').slice(0, 2).join('.') + ':' + (e.textContent || '').trim().slice(0, 10)))`);
            const rest = await names();
            await ev(`document.querySelector('#artifact-viewer .details-toggle').click(); true`);
            await waitFor(`!document.querySelector('#artifact-viewer .artifact-viewer-readers').hidden`, `${w}: Details opens`, 5000);
            const open = await names();
            assert.deepEqual(open, rest, `${w}: opening Details hides none of the other header buttons: ` + JSON.stringify([rest, open]));
            const hb = await ev(`(() => { const p = document.querySelector('#artifact-viewer .artifact-viewer-readers'), b = p.querySelector('.details-hide'), pr = p.getBoundingClientRect(), r = b.getBoundingClientRect(); return { text: b.textContent, right: Math.round(pr.right - r.right), top: Math.round(r.top - pr.top), shown: b.getClientRects().length > 0 }; })()`);
            assert.ok(hb.shown && hb.text === 'Hide details' && hb.right <= 24 && hb.top <= 12, `${w}: Hide details is at the top right of the box: ` + JSON.stringify(hb));
            await ev(`document.querySelector('#artifact-viewer .details-hide').click(); true`);
            const closedAgain = await ev(`({ hidden: document.querySelector('#artifact-viewer .artifact-viewer-readers').hidden, focus: document.activeElement && document.activeElement.classList.contains('details-toggle') })`);
            assert.deepEqual([closedAgain.hidden, closedAgain.focus], [true, true], `${w}: Hide details closes it and the keyboard goes back to Details`);
            assert.deepEqual(await names(), rest, `${w}: and the header is as it was`);
            // the ⋯ menu
            await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
            await waitFor(`!!document.querySelector('.artifact-viewer-menu:not([hidden])')`, `${w}: the ⋯ menu opens`, 4000);
            const items = await ev(`[...document.querySelectorAll('.artifact-viewer-menu [role=menuitem]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`);
            assert.deepEqual(items.filter(t => t !== 'Details'), ['Approve with a note', 'Open in new tab', 'Download'], `${w}: the ⋯ menu holds the less used (and Details when the file has facts to show): ` + JSON.stringify(items));
            await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
            // the version list holds Compare
            await ev(`document.querySelector('.av-current').click(); true`);
            await waitFor(`!!document.querySelector('.av-list:not([hidden])')`, `${w}: the version list opens`, 4000);
            const pop = await ev(`(() => { const p = document.querySelector('.av-pop').getBoundingClientRect(), d = document.querySelector('.artifact-viewer-content').getBoundingClientRect(), hit = document.elementFromPoint(p.right - 4, p.top + 12); return { left: Math.round(p.left - d.left), right: Math.round(d.right - p.right), width: Math.round(p.width), hitInside: !!hit && !!hit.closest('.av-pop') }; })()`);
            assert.ok(pop.left >= 0 && pop.right >= 0 && pop.hitInside, `${w}: the version list is inside the dialog (its right edge is not cut off, with a long file name): ` + JSON.stringify(pop));
            if (w === 390) assert.ok(pop.width > 300, `${w}: on a phone the version list is as wide as the dialog allows: ` + JSON.stringify(pop));
            assert.ok(await ev(`!!document.querySelector('.av-compare') && document.querySelector('.av-compare').getClientRects().length > 0 && document.querySelector('.av-compare').textContent.includes('Compare with v2')`), `${w}: Compare with v2 is in the version list`);
            await ev(`document.querySelector('.av-current').click(); true`);
            // Approve: the status chip says Approved at once, and the two buttons go (#12112's leftover: it kept saying "Waiting for your review")
            assert.match(await ev(`document.querySelector('.artifact-review-state').textContent`), /Waiting for your review/, `${w}: before Approve the status waits for the review`);
            await ev(`document.querySelector('.artifact-review-approve').click(); true`);
            await waitFor(`/^Approved/.test(document.querySelector('.artifact-review-state').textContent)`, `${w}: the status chip says Approved after Approve (it said: ` + await ev(`document.querySelector('.artifact-review-state').textContent`) + ')', 4000);
            assert.ok(await ev(`document.querySelector('.artifact-review-approve').hidden && document.querySelector('.artifact-review-changes').hidden`), `${w}: Approve and Request changes are gone once approved`);
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
            // the other two ways to approve while the file is open: Approve with a note, and the Inbox row's own Approve (artifact_review.approveRow) (#12112's leftover)
            for (const how of ['note', 'row']) {
                await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
                await waitFor(`!!document.querySelector('.artifact-review-approve:not([hidden])')`, `${w}: reopened, waiting for the review (${how})`, 8000);
                if (how === 'note') {
                    await ev(`document.querySelector('.artifact-viewer-more').click(); document.querySelector('.artifact-review-note').click(); true`);
                    await waitFor(`!!document.querySelector('.inbox-approve-note-confirm')`, `${w}: the note dialog opens`, 4000);
                    await ev(`document.querySelector('.inbox-approve-note-confirm').click(); true`);
                } else await ev(`import(${S} + 'artifact_review.js').then(r => import(${S} + 'server_base.js').then(b => r.approveRow(b.identityKey(undefined, 'team-a'), { id: '${H3}', name: 'release-plan.md', team: b.identityKey(undefined, 'team-a') }))).then(() => true)`);
                await waitFor(`/^Approved/.test(document.querySelector('.artifact-review-state').textContent)`, `${w}: the status chip says Approved after Approve ${how === 'note' ? 'with a note' : 'from the Inbox row'}`, 4000);
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
            }
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
        }
        console.log('   heights before/after are in the lines above: ' + JSON.stringify(heights));
    } finally { await client.close(); }
    console.log('artifact_viewer_header_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
