// Switching Analytics views redrew from the same numbers and read GET /api/board/<team>/spend?range=24h again each time (128 to 164 ms, #9086's report, #9250). One read of a team and a range is now reused for
// ten seconds; the Refresh button (force) reads again, so do a new range and a read that is older than ten seconds. jsdom, request counts.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
try {
    const doc = document;
    const reads = [];
    globalThis.fetch = window.fetch = async url => {
        const u = new URL(String(url), 'https://x.example');
        if (/\/spend$/.test(u.pathname)) { reads.push(u.pathname + u.search); return Response.json({ range: u.searchParams.get('range'), tokens: { teams: [] }, tasks: [], agents: [], commits: [], generated_at: new Date().toISOString() }); }
        if (u.pathname === '/api/board/projects') return Response.json([]);
        return Response.json({});
    };
    const { state } = await importUi('state');
    state.liveSessions = [{ session_id: 's1', name: 'a1', board_project: 'alpha', agent_type: 'claude' }];
    const S = await importUi('analytics_spend');
    const host = doc.createElement('div'), timeHost = doc.createElement('div'); doc.body.append(host, timeHost);
    const settle = () => new Promise(r => setTimeout(r, 30));
    let now = 1_000_000; const realNow = Date.now; Date.now = () => now;
    try {
        await S.showSpend(host, 'day', timeHost); await settle();
        assert.equal(reads.length, 1, 'the first view reads once: ' + reads.join(','));
        for (let i = 0; i < 4; i++) { now += 1500; await S.showSpend(host, 'day', timeHost); await settle(); }
        assert.equal(reads.length, 1, 'four view switches within ten seconds read nothing more');
        await S.showSpend(host, 'day', timeHost, true); await settle();
        assert.equal(reads.length, 2, 'Refresh (force) reads again');
        now += 11000; await S.showSpend(host, 'day', timeHost); await settle();
        assert.equal(reads.length, 3, 'the poll, after ten seconds, reads again');
        await S.showSpend(host, 'week', timeHost); await settle();
        assert.equal(reads.length, 4, 'a new range is its own read'); assert.match(reads.at(-1), /range=7d/);
        await S.showSpend(host, 'week', timeHost); await settle();
        assert.equal(reads.length, 4, 'and is reused too');
    } finally { Date.now = realNow; }
    console.log('analytics_spend_reuse: ok');
} finally { dom.close && dom.close(); }
