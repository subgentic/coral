// #13128 (QA Engineer on #13116): a link opens a file from the rows the Inbox has, up to a scan old; if the file is settled while its viewer is open, the viewer must say so when the Inbox's list is read again (Approved,
// no Approve button), not leave a decision on screen that the server would only refuse. The server's own answer to a second decision is TestApproveRefusesWhatIsNotWaitingAndWhoIsNotAPerson and the 'once' test.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: ordering a late answer after another file was opened

const HEX = 'ab'.repeat(32), HEX_B = 'cd'.repeat(32);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.__st = { a: 'pending', b: 'pending' }; window.__held = []; window.__holdApproved = false;
            const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            const art = (id, hex, name, tags) => ({ id, uri: 'coral://artifacts/' + hex, tags, name, created_at: '2026-11-04T00:00:01Z', available: true, produced_by: 'Dev', review: tags.includes('approved') ? { at: '2026-11-04T01:00:00Z' } : undefined });
            const files = [['a', '${HEX}', 'plan.html'], ['b', '${HEX_B}', 'other.html']];
            const rows = (state) => files.filter(([k]) => state === window.__st[k]).map(([k, hex, name]) => art('a-' + k, hex, name, [state === 'pending' ? 'for review' : 'approved']));
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                if (p === '/api/board/projects') return json([{ project: 't3' }]);
                const m = /^\\/api\\/board\\/t3\\/artifacts$/.exec(p);
                if (m) { const tag = url.searchParams.get('tag');
                    if (tag === 'for review') return json({ has_more: false, artifacts: rows('pending') });
                    if (tag === 'approved') { const body = { has_more: false, artifacts: rows('approved') };
                        if (window.__holdApproved) return new Promise(r => window.__held.push(() => r(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })))); // the settled-state read, held in flight
                        return json(body); }
                    return json({ has_more: false, artifacts: [] }); }
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const S = `(window.__coralStatic || '/static/')`;
        await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); await M.refreshReviews(true); return M.reviewItems().length; })()`);
        assert.equal(await ev(`(async () => (await import(${S} + 'inbox_reviews.js')).reviewItems().length)()`), 2, 'precondition: the Inbox has both files, waiting');
        await ev(`(async () => { const V = await import(${S} + 'artifact_viewer.js'); V.openArtifactViewer('${HEX}', { server: '', filename: 'plan.html', board: 't3' }); return true; })()`);
        const approveShown = `(() => { const b = document.querySelector('.artifact-review-approve'); return !!b && !b.hidden && b.checkVisibility(); })()`;
        await waitFor(approveShown, 'the viewer offers Approve for the waiting file', 8000);

        // someone settles it meanwhile; the Inbox's list is read again (the background refresh after a link opens)
        await ev(`window.__st.a = 'approved'; true`);
        await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); await M.refreshReviews(true); return true; })()`);
        await waitFor(`/^Approved/.test((document.querySelector('.artifact-review-state') || {}).textContent || '')`, 'the viewer says the file is Approved', 8000);
        assert.equal(await ev(approveShown), false, 'and offers no Approve button for it');

        // QA Engineer's SHOULD (b): another file is opened while the settled-state read is in flight: its viewer is not overwritten by the first file's late answer (the `g === gen && cur === was` guard)
        await ev(`window.__st = { a: 'pending', b: 'pending' }; true`);
        await ev(`(async () => { await (await import(${S} + 'inbox_reviews.js')).refreshReviews(true); const V = await import(${S} + 'artifact_viewer.js'); V.openArtifactViewer('${HEX}', { server: '', filename: 'plan.html', board: 't3' }); return true; })()`);
        await waitFor(approveShown, 'the viewer offers Approve for plan.html again', 8000);
        await ev(`window.__holdApproved = true; window.__st.a = 'approved'; (async () => { await (await import(${S} + 'inbox_reviews.js')).refreshReviews(true); })(); true`); // the list loses plan.html: its viewer asks the file's own state, and that read is held
        await waitFor(`window.__held.length >= 1`, "the first file's settled-state read is in flight", 8000);
        await ev(`(async () => { const V = await import(${S} + 'artifact_viewer.js'); V.openArtifactViewer('${HEX_B}', { server: '', filename: 'other.html', board: 't3' }); return true; })()`);
        await waitFor(`${approveShown} && document.querySelector('.artifact-viewer-title').textContent === 'other.html'`, "the second file's viewer is open and offers Approve", 8000);
        await ev(`window.__holdApproved = false; window.__held.splice(0).forEach(f => f()); true`); // the first file's late answer: Approved
        await sleep(800); // sleep-ok: the late answer is handled in a few tasks; only waiting shows that it changed nothing
        assert.equal(await ev(`document.querySelector('.artifact-viewer-title').textContent`), 'other.html', 'the second file is still the one open');
        assert.equal(await ev(approveShown), true, "the second file's Approve is still offered: the first file's late answer did not overwrite its viewer");
        assert.ok(!/^Approved/.test(await ev(`(document.querySelector('.artifact-review-state') || {}).textContent || ''`)), "and its state line does not say Approved");
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
