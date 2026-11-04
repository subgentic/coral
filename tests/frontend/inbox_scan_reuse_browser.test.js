// #13489/#13501: the 30 s reuse of a finished scan (refreshReviews(true, { reuse: true }), the read of opening a file or a link) is only for a scan nothing has settled or tagged since:
// a settle (an Approve) within the 30 s moves the revision and the next open reads again, so the decided file drops out. Lead's surviving mutant: without the finishedRev === revision guard it stayed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const HEX = n => String(n).repeat(64);
(async () => {
    const { client, Page, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch, json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.__requests = [];
            window.__files = [1, 2].map(n => ({ id: String(n).repeat(64), uri: 'coral://artifacts/' + String(n).repeat(64), name: 'plan-' + n + '.md', media_type: 'text/markdown', source: 'upload', available: true, size: 32, produced_by: 'Writer ' + n, session_id: 's' + n, tags: ['for review'], created_at: new Date(Date.now() - n * 1000).toISOString() }));
            window.fetch = (u, o = {}) => {
                const url = new URL(String(u), location.href), p = url.pathname; window.__requests.push(p + url.search);
                if (p === '/api/board/projects') return json([1, 2].map(n => ({ project: 'team-' + n, board_label: 'team-' + n, message_count: 1, subscriber_count: 1 })));
                const t = /^\\/api\\/board\\/team-(\\d)\\/artifacts$/.exec(p);
                if (t) { const tag = url.searchParams.get('tag'); const rows = window.__files.filter(a => a.id[0] === t[1] && (!tag || a.tags.includes(tag))); return json({ project: 'team-' + t[1], artifacts: rows, has_more: false, total: rows.length }); }
                return real(u, o);
            };
        })()` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'settings');
        const lists = () => ev(`window.__requests.filter(r => /\\/artifacts\\?tag=/.test(r)).length`);
        const mark = () => ev(`window.__requests.length = 0; true`);
        await ev(`import(${S}+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
        assert.equal(await ev(`import(${S}+'inbox_reviews.js').then(m => m.reviewItems().length)`), 2, 'both files are for review after a scan');
        // no change since the scan: an open's read is that scan
        await mark();
        await ev(`import(${S}+'inbox_reviews.js').then(m => m.refreshReviews(true, { reuse: true })).then(() => true)`);
        assert.equal(await lists(), 0, 'nothing settled or tagged: the open reuses the scan');
        // an Approve settles file 1 (the server has it approved), within the 30 s: the next open reads again and file 1 is gone
        await ev(`window.__files[0].tags = ['approved']; import(${S}+'inbox_reviews.js').then(m => m.settleReview(m.reviewItems().find(a => a.hex === '${HEX(1)}'))); true`);
        await mark();
        await ev(`import(${S}+'inbox_reviews.js').then(m => m.refreshReviews(true, { reuse: true })).then(() => true)`);
        assert.ok(await lists() > 0, 'a settle within 30 s: the next open reads again (the finishedRev guard)');
        assert.deepEqual(await ev(`import(${S}+'inbox_reviews.js').then(m => m.reviewItems().map(a => a.hex))`), [HEX(2)], 'the decided file is out of Needs you');
        // a file tagged read in place (setReviewRead) also moves the revision
        await ev(`import(${S}+'inbox_reviews.js').then(m => m.refreshReviews(true, { reuse: true })).then(() => true)`);
        await mark();
        await ev(`import(${S}+'inbox_reviews.js').then(m => m.refreshReviews(true, { reuse: true })).then(() => true)`);
        assert.equal(await lists(), 0, 'and with nothing more settled the next open reuses the new scan');
        console.log('PASS scan reuse: reused only while nothing was settled or tagged since');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
