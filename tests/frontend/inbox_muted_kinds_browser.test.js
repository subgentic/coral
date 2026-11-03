// What reaches Needs you follows the Operator's settings (#12144, slice 1): the server marks a file of a kind that is switched off, or of a team that is not included, muted. The page leaves a muted file out of
// Needs you, its rows, its badge and the count the title shows, and keeps it listed apart (the Muted line's source). A question is never muted: it does not come from the files list at all. Real dev server;
// the board's answers are stubbed on the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            console.log(`${w}px`);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const real = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                const hex = c => c.repeat(64), at = i => new Date(Date.now() - i * 60000).toISOString();
                const file = (c, name, extra) => ({ id: hex(c), name, uri: 'coral://artifacts/' + hex(c), digest: hex(c), available: true, tags: ['for review'], created_at: at(3), ...extra });
                window.__files = [file('a', 'plan.md'), file('b', 'release-notes.md', { kind: 'release', muted: true }), file('c', 'finished.md', { kind: 'done' }), file('d', 'decisions.md', { kind: 'decided', muted: true })];
                window.fetch = (u, o) => { const url = new URL(String(u), location.href);
                    if (url.pathname === '/api/board/projects') return json([{ project: 'alpha' }]);
                    if (url.pathname === '/api/board/alpha/artifacts' && url.searchParams.get('tag') === 'for review') return json({ artifacts: window.__files, has_more: false });
                    if (url.pathname === '/api/board/alpha/artifacts') return json({ artifacts: [], has_more: false });
                    return real(u, o); }; return true; })()`);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
            await waitFor(`import(${S} + 'inbox_reviews.js').then(m => m.reviewItems().length > 0)`, 'the reviews are read', 8000).catch(() => {});
            const out = await ev(`import(${S} + 'inbox_reviews.js').then(m => ({ rows: m.reviewItems().map(a => a.name).sort(), unread: m.unreadReviewItems().length, muted: m.mutedReviewItems().map(a => a.name).sort() }))`);
            assert.deepEqual(out.rows, ['finished.md', 'plan.md'], `${w}px: only the files that are not muted are Needs you rows: ` + JSON.stringify(out));
            assert.equal(out.unread, 2, `${w}px: the count is the unmuted files`);
            assert.deepEqual(out.muted, ['decisions.md', 'release-notes.md'], `${w}px: the muted files are kept apart, listed, not dropped`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return true; })`);
            const badge = await ev(`(document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || ''`);
            assert.equal(badge.trim(), '2', `${w}px: the badge says 2, not 4: the muted files are not counted`);
            // the switch turned back on: the server stops marking them, and the next read counts all four
            await ev(`window.__files = window.__files.map(f => ({ ...f, muted: false })); import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
            const back = await ev(`import(${S} + 'inbox_reviews.js').then(m => ({ unread: m.unreadReviewItems().length, muted: m.mutedReviewItems().length }))`);
            assert.deepEqual(back, { unread: 4, muted: 0 }, `${w}px: switched back on, all four count and none is muted`);
            console.log('   ✓');
        }
        console.log('PASS muted kinds: left out of the rows and the count, kept listed, and counted again when switched on');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
