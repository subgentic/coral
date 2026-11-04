// #13128 (QA Engineer on #13116): a link opens a file from the rows the Inbox has, up to a scan old; if the file is settled while its viewer is open, the viewer must say so when the Inbox's list is read again (Approved,
// no Approve button), not leave a decision on screen that the server would only refuse. The server's own answer to a second decision is TestApproveRefusesWhatIsNotWaitingAndWhoIsNotAPerson and the 'once' test.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HEX = 'ab'.repeat(32);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.__st = 'pending';
            const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            const art = tags => ({ id: 'a-1', uri: 'coral://artifacts/${HEX}', tags, name: 'plan.html', created_at: '2026-11-04T00:00:01Z', available: true, produced_by: 'Dev', review: tags.includes('approved') ? { at: '2026-11-04T01:00:00Z' } : undefined });
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                if (p === '/api/board/projects') return json([{ project: 't3' }]);
                const m = /^\\/api\\/board\\/t3\\/artifacts$/.exec(p);
                if (m) { const tag = url.searchParams.get('tag');
                    if (tag === 'for review') return json({ has_more: false, artifacts: window.__st === 'pending' ? [art(['for review'])] : [] });
                    if (tag === 'approved') return json({ has_more: false, artifacts: window.__st === 'approved' ? [art(['approved'])] : [] });
                    return json({ has_more: false, artifacts: [] }); }
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const S = `(window.__coralStatic || '/static/')`;
        await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); await M.refreshReviews(true); return M.reviewItems().length; })()`);
        assert.equal(await ev(`(async () => (await import(${S} + 'inbox_reviews.js')).reviewItems().length)()`), 1, 'precondition: the Inbox has the file, waiting');
        await ev(`(async () => { const V = await import(${S} + 'artifact_viewer.js'); V.openArtifactViewer('${HEX}', { server: '', filename: 'plan.html', board: 't3' }); return true; })()`);
        const approveShown = `(() => { const b = document.querySelector('.artifact-review-approve'); return !!b && !b.hidden && b.checkVisibility(); })()`;
        await waitFor(approveShown, 'the viewer offers Approve for the waiting file', 8000);

        // someone settles it meanwhile; the Inbox's list is read again (the background refresh after a link opens)
        await ev(`window.__st = 'approved'; true`);
        await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); await M.refreshReviews(true); return true; })()`);
        await waitFor(`/^Approved/.test((document.querySelector('.artifact-review-state') || {}).textContent || '')`, 'the viewer says the file is Approved', 8000);
        assert.equal(await ev(approveShown), false, 'and offers no Approve button for it');
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
