// #13958: opening reviews reads only the first protected page of each computer.
import assert from 'node:assert/strict';
import { state } from '../../coral-go/pkg/frontend/static/state.js';
import { keyLabel } from '../../coral-go/pkg/frontend/static/server_base.js';
import * as M from '../../coral-go/pkg/frontend/static/inbox_reviews.js';
state.hub = true; state.serversKnown = true;
state.servers = [{ id: 'box-b', status: 'online' }];
const rows = Array.from({ length: 65 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), board_id: 'alpha', name: `File ${i}`, session_id: 'writer', produced_by: 'Writer', tags: ['for review'], available: true, created_at: '2026-11-06T12:00:00Z' }));
const calls = [];
let failMore = false;
globalThis.fetch = async input => {
    const url = new URL(String(input), 'http://localhost');
    assert.ok(url.pathname.endsWith('/api/team-artifacts'), `opening reviews must not scan boards: ${url.pathname}`);
    const server = url.pathname.startsWith('/api/remote/box-b/') ? 'box-b' : 'local';
    const tag = url.searchParams.get('tag');
    calls.push({ server, tag, cursor: url.searchParams.get('cursor') || '', limit: url.searchParams.get('limit') });
    assert.equal(url.searchParams.get('limit'), '50');
    if (tag === 'saved') return Response.json({ artifacts: [], total: 0, has_more: false, tag_counts: {} });
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
        assert.equal(cursor, `${server}:50`, 'a cursor belongs to its source computer');
        if (failMore) return Response.json({ error: 'offline' }, { status: 503 });
    }
    return Response.json({ teams: [{ board_id: 'alpha', team: 'Product' }], artifacts: rows.slice(cursor ? 50 : 0, cursor ? 100 : 50), total: 65, has_more: !cursor, ...(cursor ? {} : { next_cursor: `${server}:50` }), tag_counts: { 'for review': 65 } });
};
await M.refreshReviews();
assert.equal(calls.length, 0, 'startup badges do not trigger a review scan');
await M.refreshReviews(true);
assert.equal(calls.length, 4, 'one review page and one saved page per computer, no cursor drain');
assert.equal(M.reviewItems().length, 100);
assert.ok(keyLabel('alpha').startsWith('Product'), 'team labels come from the same protected response, without a project scan');
assert.equal(new Set(M.reviewItems().map(r => r.reviewKey)).size, 100, 'identical digests on two computers retain qualified identities');
assert.deepEqual(M.reviewPages().map(p => [p.server, p.total, p.has_more]), [['local', 65, true], ['box-b', 65, true]]);
failMore = true; await M.loadMoreReviews('box-b');
assert.equal(M.reviewItems().length, 100, 'a failed append retains loaded rows');
assert.ok(M.reviewErrors().some(e => e.includes('box-b')));
failMore = false; await M.loadMoreReviews('box-b');
assert.equal(M.reviewItems().length, 115);
assert.equal(M.reviewPages().find(s => s.server === 'local').next_cursor, 'local:50');
assert.equal(M.reviewPages().find(s => s.server === 'box-b').has_more, false);
assert.equal(M.reviewPageSummary().queryTotal, 130);
assert.equal(M.reviewPageSummary().attentionTotal, null, 'query total cannot stand in for off-page attention facts');
await M.loadMoreReviews('local');
assert.equal(M.reviewPageSummary().attentionTotal, 130, 'a complete loaded window can be counted using the actual row policy');
console.log('review_loading: bounded protected reads, metadata, source-qualified rows and explicit retryable paging pass');
