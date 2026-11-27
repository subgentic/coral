// #21825: first-load attention count, review rows and all-files count have
// different queries. Start them together; share each computer/query only once.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld } = require('./helpers/hub_world');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false, inbox: 'native', needs: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            window.__coralNoFetchShare = false;
            const real = window.fetch;
            window.__artifactReads = []; window.__artifactReleases = [];
            window.fetch = function(u, o = {}) {
                const url = new URL(String(u && u.url || u), location.href);
                if ((o.method || 'GET') !== 'GET' || !url.pathname.endsWith('/api/team-artifacts')) return real.apply(this, arguments);
                const q = new URLSearchParams(url.search); q.sort();
                window.__artifactReads.push({ path: url.pathname, query: q.toString() });
                return new Promise(resolve => window.__artifactReleases.push(() => resolve(real(u, o))));
            };
        })()` });
        await Page.navigate({ url: BASE + '/inbox/needs' }); await Page.loadEventFired();
        // None of these responses is released until every query has started: a
        // serial dependency cannot pass by merely finishing within a time budget.
        try {
            await waitFor(`window.__artifactReads.length >= 6`, 'three artifact queries on both computers start before any answer', 12000);
        } catch (error) {
            assert.fail(error.message + ': ' + JSON.stringify(await ev(`window.__artifactReads`)));
        }
        const reads = await ev(`window.__artifactReads`);
        assert.equal(reads.length, 6, 'one request per computer and query on first Inbox load');
        assert.equal(new Set(reads.map(r => r.path + '?' + r.query)).size, 6, 'no duplicate computer/query');
        for (const computer of ['m1', 'm2']) {
            const queries = reads.filter(r => r.path === '/api/remote/' + computer + '/api/team-artifacts').map(r => new URLSearchParams(r.query));
            assert.equal(queries.length, 3, computer + ': all three independent reads');
            assert.ok(queries.some(q => q.get('waiting') === '1' && q.get('muted') === '0'), computer + ': attention count');
            assert.ok(queries.some(q => q.get('limit') === '50' && q.has('facets')), computer + ': review rows');
            assert.ok(queries.some(q => !q.has('tag') && q.get('limit') === '1'), computer + ': all-files count');
        }
        await ev(`window.__artifactReleases.splice(0).forEach(release => release()); true`);
        await waitFor(`!!document.querySelector('#group-table-view .inbox-needs-results, #group-table-view .empty-state')`, 'the Inbox paints after the parallel reads', 10000);
        assert.equal(await ev(`window.__artifactReads.length`), 6, 'settling the first reads does not fetch any query again');
        console.log('PASS each first-load Hub artifact query starts in parallel and is fetched once per computer');
    } finally { await ev(`window.__artifactReleases?.splice(0).forEach(release => release()); true`).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exit(1); });
