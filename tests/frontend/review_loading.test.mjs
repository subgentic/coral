// #13958: opening reviews reads only the first protected page of each computer.
import assert from 'node:assert/strict';
import { state } from '../../coral-go/pkg/frontend/static/state.js';
import { keyLabel } from '../../coral-go/pkg/frontend/static/server_base.js';
import { prepareAskReviews, isHiddenAsk } from '../../coral-go/pkg/frontend/static/ask_filter.js';
import * as M from '../../coral-go/pkg/frontend/static/inbox_reviews.js';
state.hub = true; state.serversKnown = true;
state.servers = [{ id: 'box-b', status: 'online' }];
const rows = Array.from({ length: 65 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), board_id: 'alpha', name: `File ${i}`, session_id: 'writer', produced_by: 'Writer', tags: ['for review'], available: true, created_at: '2026-11-06T12:00:00Z' }));
const calls = [];
let failMore = false, ignoreDigest = false;
globalThis.fetch = async input => {
    const url = new URL(String(input), 'http://localhost');
    assert.ok(url.pathname.endsWith('/api/team-artifacts'), `opening reviews must not scan boards: ${url.pathname}`);
    const server = url.pathname.startsWith('/api/remote/box-b/') ? 'box-b' : 'local';
    const tag = url.searchParams.get('tag');
    calls.push({ server, tag, cursor: url.searchParams.get('cursor') || '', limit: url.searchParams.get('limit') });
    assert.equal(url.searchParams.get('limit'), url.searchParams.get('waiting') === '1' ? '1' : '50');
    if (url.searchParams.get('waiting') === '1') return Response.json({ artifacts: [], total: 125, has_more: true, next_cursor: 'count-only' });
    if (url.searchParams.has('digest') && !ignoreDigest) {
        assert.equal(url.searchParams.get('team'), 'alpha');
        assert.equal(url.searchParams.has('cursor'), false);
        return Response.json({ artifacts: rows.filter(r => r.id === url.searchParams.get('digest')), has_more: false });
    }
    if (tag === 'saved') {
        const all = rows.map((r, i) => ({ ...r, id: (i + 1001).toString(16).padStart(64, '0'), name: 'Saved ' + i, tags: ['saved', 'for review'] }));
        const cursor = url.searchParams.get('cursor');
        return Response.json({ artifacts: all.slice(cursor ? 50 : 0, cursor ? 100 : 50), total: 65, has_more: !cursor, ...(cursor ? {} : { next_cursor: server + ':50' }), tag_counts: { saved: 65, 'for review': 65 } });
    }
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
        assert.equal(cursor, `${server}:50`, 'a cursor belongs to its source computer');
        if (failMore) return Response.json({ error: 'offline' }, { status: 503 });
    }
    return Response.json({ teams: [{ board_id: 'alpha', team: 'Product' }], artifacts: rows.slice(cursor ? 50 : 0, cursor ? 100 : 50), total: 65, has_more: !cursor, ...(cursor ? {} : { next_cursor: `${server}:50` }), tag_counts: { 'for review': 65 }, facets: { team: [{ v: 'Product', n: 65 }], by: [{ v: 'Off-page writer', n: 1 }], goal: [{ id: 77, v: 'Off-page goal', n: 1 }] } });
};
await M.refreshReviews();
assert.equal(calls.length, 0, 'startup badges do not trigger a review scan');
await M.refreshReviews(true);
assert.equal(calls.length, 4, 'one review page and one saved page per computer, no cursor drain');
assert.equal(M.reviewItems().length, 100);
const linkedAsk = { board: 'alpha', server: 'box-b', text: `Please review coral://artifacts/${rows[64].id}` };
await prepareAskReviews([linkedAsk]);
assert.equal(isHiddenAsk(linkedAsk), true, 'an off-page duplicate is checked with the protected digest filter');
assert.equal(isHiddenAsk({ ...linkedAsk, server: 'local' }), false, 'the same digest on another computer cannot hide a question');

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
const beforeLookup = calls.length;
const offPage = await M.reviewOfTeam('@box-b/alpha', rows[64].id);
assert.equal(offPage.reviewKey, `@box-b/alpha:${rows[64].id}`);
assert.equal(calls.length, beforeLookup + 1, 'an off-page file uses one protected targeted read');
assert.equal(calls.at(-1).server, 'box-b');
assert.deepEqual(await M.currentTags(offPage), ['for review']);
ignoreDigest = true;
await assert.rejects(M.reviewOfTeam('@box-b/alpha', rows[64].id), /scoped review file/, 'a server ignoring digest never turns into a false missing-file result');
await assert.rejects(M.reviewOfTeam('alpha', 'invalid'), /valid digest/);
console.log('review_loading: bounded protected reads, metadata, source-qualified rows and explicit retryable paging pass');

ignoreDigest = false;
const options = M.reviewFilterOptions();
assert.ok(options.agents.includes('Off-page writer'), 'filter choices include server facets absent from loaded rows');
const remoteGoal = options.goals.find(g => g.server === 'box-b');
assert.ok(remoteGoal && remoteGoal.id === 77);
const beforeQuery = calls.length;
await M.queryReviews({ goal: remoteGoal.value });
assert.equal(calls.length, beforeQuery + 2, 'one first page and one attention summary, on the selected computer only');
assert.ok(calls.slice(beforeQuery).every(c => c.server === 'box-b'));
assert.equal(M.reviewQueryState().attentionTotal, 125, 'filtered attention comes from the server, independent of loaded rows');
assert.equal(M.reviewQueryState().shown, 50);
assert.equal(M.reviewQueryState().goalFiltered, true);

await M.queryReviews({ goal: 'No goal' });
assert.equal(M.reviewQueryState().attentionTotal, null, 'client-only criteria remain a lower bound while pages remain');
await M.moreQueriedReviews({ goal: 'No goal' });
assert.equal(M.reviewQueryState().attentionTotal, 130, 'a complete window can count the client-only criterion exactly');
await M.queryReviews({ agent: 'Unknown agent' });
assert.equal(M.reviewQueryState().shown, 0);
assert.equal(M.reviewQueryState().more, true, 'no match in a loaded page does not hide access to later pages');
assert.ok(M.reviewQueryKey({ sort: 'oldest' }), 'oldest sort starts its own server window, even without a text filter');

await M.queryReviews({ server: 'offline-computer' });
assert.equal(M.reviewQueryState().attentionTotal, null, 'an unavailable selected source is unknown, not zero');
assert.equal(M.reviewQueryState().total, null);
assert.match(M.reviewQueryState().error, /not.*online|No selected computer is online/);

assert.equal(M.savedFiles().length, 100);
assert.deepEqual(M.countSavedReviews(), { value: 130, complete: true }, 'Saved uses tag-count metadata for its review-file total, not the loaded page length');
await M.loadMoreSavedFiles('box-b');
assert.equal(M.savedFiles().length, 115);
assert.equal(M.countSavedReviews().value, 130);
