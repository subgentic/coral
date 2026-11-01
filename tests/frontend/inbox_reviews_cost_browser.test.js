// The Inbox does not freeze when many files are for review (#11633, the operator: after Approve "nothing in the Inbox worked until a reload"). reviewItems() (one row per artifact, the newest version with its earlier ones,
// #11533) compared every item with every other and built a JSON key for each pair, and the badge, the counts, the pills, the rows and the labels each ask for it on every update: with a thousand files for review a call
// took a tenth of a second, a redraw dozens of calls, and an Approve three redraws. It is now worked out once per change. Here: 1000 files for review (a few hundred series of two to four versions), 50 calls take well under a second
// (they took six), the answer is exactly the naive one (same rows, same order, the same earlier versions), and it follows a settled row (and the versions before it) and a read tag written in place. Stubbed team list, the real module.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const S = `(window.__coralStatic || '/static/')`;
        const r = await ev(`(async () => {
            const team = 'cost-probe', N = 1000;
            const hexOf = i => (i + 1).toString(16).padStart(64, '0');
            const rows = Array.from({ length: N }, (_, i) => ({ id: hexOf(i), name: 'file-' + (i % 50) + '.md', session_id: 's' + (i % 7), produced_by: 'Agent ' + (i % 7), created_at: new Date(Date.now() - (N - i) * 60000).toISOString(), available: true, tags: ['for review'], uri: 'coral://artifacts/' + hexOf(i), media_type: 'text/markdown' }));
            const orig = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const s = String(u);
                if (s.includes('/api/board/projects')) return json([{ project: team }]);
                if (s.includes('/api/board/' + team + '/artifacts') && s.includes('/tags')) { const id = s.split('/artifacts/')[1].split('/')[0], hit = rows.find(x => x.id === id); if (hit && o && o.method === 'PUT') hit.tags = JSON.parse(o.body).tags; return json({ tags: hit ? hit.tags : [] }); }
                if (s.includes('/api/board/' + team + '/artifacts')) return json({ artifacts: rows, has_more: false });
                return orig(u, o); };
            const m = await import(${S} + 'inbox_reviews.js');
            await m.refreshReviews(true);
            const out = {};
            const t0 = performance.now(); let list = m.reviewItems(); for (let i = 0; i < 50; i++) { list = m.reviewItems(); m.unreadReviewItems(); } out.fiftyCallsMs = Math.round(performance.now() - t0);
            out.series = list.length; out.withEarlier = list.filter(x => x.earlier).length;
            // the naive answer, on the same rows
            const items = [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
            const key = a => JSON.stringify([team, a.session_id, a.produced_by, a.name]);
            const naive = items.filter(a => !items.some(b => key(b) === key(a) && (String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id)) < 0));
            out.sameRows = JSON.stringify(list.map(x => x.id)) === JSON.stringify(naive.map(x => x.id));
            out.sameEarlier = list.every(x => JSON.stringify((x.earlier || []).map(e => e.id)) === JSON.stringify(items.filter(b => key(b) === key(x) && b.id !== x.id && (String(b.created_at).localeCompare(String(x.created_at)) || b.id.localeCompare(x.id)) < 0).map(e => e.id)));
            // a settled row leaves with the versions before it (they were settled with it): one series fewer
            const top = list.find(x => x.earlier && x.earlier.length), before = top.earlier[top.earlier.length - 1].id;
            m.settleReview(top);
            const after = m.reviewItems();
            out.goneAfterSettle = !after.some(x => x.id === top.id) && !after.some(x => x.id === before); out.oneSeriesFewer = after.length === list.length - 1;
            // a read tag written in place is seen at once
            const some = after[0];
            out.unreadBefore = m.unreadReviewItems().length;
            await m.setReviewRead(some, true);
            out.unreadAfter = m.unreadReviewItems().length;
            window.fetch = orig;
            return out;
        })()`);
        assert.ok(r.fiftyCallsMs < 500, '50 calls with 1000 files for review take ' + r.fiftyCallsMs + ' ms (the quadratic way took about 6000): ' + JSON.stringify(r));
        assert.ok(r.series > 100 && r.withEarlier > 50, 'the rows are series with earlier versions: ' + JSON.stringify(r));
        assert.ok(r.sameRows && r.sameEarlier, 'the answer is the naive one: ' + JSON.stringify(r));
        assert.ok(r.goneAfterSettle && r.oneSeriesFewer, 'a settled row leaves with its earlier versions, one series fewer: ' + JSON.stringify(r));
        assert.equal(r.unreadAfter, r.unreadBefore - 1, 'a read tag written in place counts at once: ' + JSON.stringify(r));
        console.log('inbox_reviews_cost_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
