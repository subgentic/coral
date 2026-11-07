// #13161/#13958: protected computer windows read 50, append explicitly, and
// resolve an off-page file by digest. A missing cursor is an incomplete read,
// retaining the prior window; it never starts a legacy whole-list/offset walk.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const N = 130;
const hexOf = i => String(i + 1).padStart(64, '0');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch, N = ${N}; window.__mode = 'cursor'; window.__calls = [];
            const hex = i => String(i + 1).padStart(64, '0');
            const art = i => ({ id: hex(i), uri: 'coral://artifacts/' + hex(i), tags: ['for review'], name: 'file-' + String(i).padStart(3, '0') + '.html', created_at: new Date(Date.UTC(2026, 10, 4) - i * 1000).toISOString(), available: true, produced_by: 'Dev', session_id: 's-' + i });
            const savedArt = i => ({ ...art(i), id: hex(i + 1000), uri: 'coral://artifacts/' + hex(i + 1000), name: 'saved-' + String(i).padStart(3, '0') + '.html', tags: ['saved', 'for review'], session_id: 'ss-' + i });
            const reviews = Array.from({length: N}, (_, i) => art(i)), saved = Array.from({length: N}, (_, i) => savedArt(i));
            window.fetch = (input, options) => {
                const url = new URL(String(input), location.href);
                // Each independent stream supplies its complete fixture population.
                const collection = url.searchParams.get('tag') === 'saved' ? saved : url.searchParams.get('tag') === 'for review' ? reviews : [...reviews, ...saved];
                const body = window.__reviewFixturePage(url, location.href, { t1: collection });
                if (body) {
                    window.__calls.push(url.search);
                    if (window.__mode === 'missing-cursor' && body.has_more && url.searchParams.get('limit') === '50') delete body.next_cursor;
                    return Promise.resolve(Response.json(body));
                }
                return real(input, options);
            };
        })();` });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const first = await ev(`(async () => { window.__M = await import(${S} + 'inbox_reviews.js'); await window.__M.refreshReviews(true); return { review: window.__M.reviewItems().length, saved: window.__M.savedFiles().length }; })()`);
        assert.deepEqual(first, { review: 50, saved: 50 }, 'one first page per independent stream');
        assert.ok(await ev(`window.__calls.every(c => !new URLSearchParams(c).has('cursor'))`), 'opening never drains cursor pages');
        const before = await ev(`window.__calls.length`);
        assert.equal(await ev(`import(${S} + 'artifact_review.js').then(m => m.reviewStateOf('t1', '${hexOf(119)}')).then(s => s && s.state)`), 'pending');
        assert.deepEqual(await ev(`window.__M.currentTags({team: 't1', id: '${hexOf(119)}'})`), ['for review']);
        const exact = await ev(`window.__calls.slice(${before}).map(c => Object.fromEntries(new URLSearchParams(c)))`);
        assert.equal(exact.length, 2, 'viewer state and fresh tags each use one targeted read');
        assert.ok(exact.every(q => q.digest === hexOf(119) && q.team === 't1' && !q.cursor), 'off-page lookups are source/team/digest scoped, without a scan');

        await ev(`window.__mode = 'missing-cursor'; window.__M.refreshReviews(true)`);
        assert.equal(await ev(`window.__M.reviewItems().length`), 50, 'an unusable refresh keeps the review window');
        assert.equal(await ev(`window.__M.savedFiles().length`), 50, 'and the Saved window');
        assert.match(await ev(`window.__M.reviewPages()[0].error`), /cursor/, 'the incomplete answer is reported');
        await ev(`window.__mode = 'cursor'; window.__M.refreshReviews(true)`);
        assert.equal(await ev(`window.__M.reviewPages()[0].error`), '', 'a valid refresh recovers');

        await ev(`window.__M.loadMoreReviews('local')`);
        assert.equal(await ev(`window.__M.reviewItems().length`), 100);
        assert.equal(await ev(`window.__M.savedFiles().length`), 50, 'review append does not advance Saved');
        await ev(`window.__M.loadMoreSavedFiles('local')`);
        assert.equal(await ev(`window.__M.savedFiles().length`), 100);
        await ev(`Promise.all([window.__M.loadMoreReviews('local'), window.__M.loadMoreSavedFiles('local')])`);
        const all = await ev(`({review: window.__M.reviewItems().length, saved: window.__M.savedFiles().length, unique: new Set(window.__M.reviewItems().map(r=>r.reviewKey)).size, savedCount: window.__M.countSavedReviews().value, more: window.__M.reviewPages()[0].has_more})`);
        assert.deepEqual(all, { review: N, saved: N, unique: N, savedCount: N, more: false }, 'explicit pages find each file once and retain authoritative metadata');
        const requests = await ev(`window.__calls.map(c => Object.fromEntries(new URLSearchParams(c)))`);
        assert.ok(requests.every(q => q.limit === '50' || q.limit === '1'), 'no 200-row requests');
        assert.ok(requests.every(q => !q.offset), 'no automatic legacy offset fallback');
        console.log('PASS protected 50-row windows, explicit independent append, retained failed refresh and exact off-page lookups');
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
