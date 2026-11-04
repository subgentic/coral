// #13162, UI Reviewer's three MUSTs on the filtered Needs you walk, with the real module and a stub computer that validates cursors the way the server does (its cursor is bound to the query's parameters, until included):
//  1 the parameters (and the time of waited-longer-than) are made once for a walk, so Show more is not refused;
//  2 a team whose page failed keeps its cursor, Show more and Retry ask it again, no gap and no repeat;
//  3 a row the Operator settled while an answer was on its way does not come back from it.
import assert from 'node:assert/strict';

let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
Date.now = () => clock;
const hex = i => i.toString(16).padStart(64, 'c');
const art = i => ({ id: 'a-' + i, uri: 'coral://artifacts/' + hex(i), tags: ['for review'], name: `file-${String(i).padStart(3, '0')}.md`, created_at: new Date(Date.UTC(2026, 10, 4) - i * 1000).toISOString(), available: true, produced_by: 'Dev', session_id: 's-1' });
const TEAMS = { a: Array.from({ length: 120 }, (_, i) => art(i)), b: Array.from({ length: 120 }, (_, i) => art(1000 + i)) };
let failOnce = new Set(), asked = [], hold = null, laterTotals = false; // laterTotals: a computer whose total on a later page counts what is left (the page must keep the first page's)
globalThis.fetch = async (url) => {
    const u = new URL(url, 'http://localhost'), p = u.pathname;
    if (p === '/api/board/projects') return Response.json([{ project: 'a' }, { project: 'b' }]);
    const m = /^\/api\/board\/(a|b)\/artifacts$/.exec(p);
    if (!m) return Response.json({});
    const team = m[1], tag = u.searchParams.get('tag');
    if (tag === 'saved') return Response.json({ artifacts: [], has_more: false });
    const cursor = u.searchParams.get('cursor') || '', until = u.searchParams.get('until') || '';
    const rest = new URLSearchParams(u.searchParams); rest.delete('cursor'); rest.sort();
    asked.push({ team, cursor, until, params: rest.toString() });
    if (hold && hold.team === team && (hold.cursor === undefined ? !cursor : cursor.startsWith(hold.cursor))) await hold.promise;
    if (failOnce.has(team + ':' + cursor)) { failOnce.delete(team + ':' + cursor); return Response.json({}, { status: 503 }); }
    let start = 0;
    if (cursor) { const [at, boundUntil] = cursor.split('|'); if (boundUntil !== until) return Response.json({ error: 'invalid cursor' }, { status: 400 }); start = Number(at); } // the server's fingerprint includes until
    const page = TEAMS[team].slice(start, start + 50), more = start + 50 < TEAMS[team].length;
    return Response.json({ artifacts: page, has_more: more, total: laterTotals && cursor ? TEAMS[team].length - start : TEAMS[team].length, ...(more ? { next_cursor: `${start + 50}|${until}` } : {}) });
};
const M = await import('../../coral-go/pkg/frontend/static/inbox_reviews.js');
const keys = () => M.queriedReviews(F)?.map(r => r.reviewKey) || [];
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)); };

// 1: waiting longer than: the time is taken once; the cursor is accepted on every Show more
let F = { longer: '30' };
asked = [];
await M.queryReviews(F);
assert.equal(M.reviewQueryState().shown, 100, 'the first page of each team');
clock += 5000; // time passes before the person asks for more
await M.moreQueriedReviews(F);
assert.equal(M.reviewQueryState().error, '', 'the cursor was accepted: ' + JSON.stringify(asked.filter(a => a.cursor).map(a => a.until)));
assert.equal(M.reviewQueryState().shown, 200, 'the second pages arrived');
assert.equal(new Set(asked.filter(a => a.cursor).map(a => a.until)).size, 1, 'every page of the walk sent the one time');
assert.equal(new Set(asked.map(a => a.until)).size, 1, 'the same time on the first pages and the later ones');
await M.moreQueriedReviews(F);
assert.equal(M.reviewQueryState().shown, 240, 'and the last pages');
assert.equal(M.reviewQueryState().more, false);

// 2: a transient failure of one team's next page keeps its cursor; Retry asks it again; mixed teams, no gap and no repeat
F = { q: 'retry-walk' };
asked = [];
await M.queryReviews(F);
assert.equal(M.reviewQueryState().shown, 100);
failOnce.add('b:50|');
await M.moreQueriedReviews(F);
let st = M.reviewQueryState();
assert.equal(st.failed, 1, 'one team did not answer');
assert.ok(st.more, 'Show more is still there (the failed team keeps its cursor, the other has more too)');
assert.match(st.error, /could not be asked/);
assert.equal(keys().filter(k => k.startsWith('b:')).length, 50, "team b is where it was: its failed page is not skipped");
assert.equal(keys().filter(k => k.startsWith('a:')).length, 100, 'team a moved on');
await M.retryQueriedReviews(F);
st = M.reviewQueryState();
assert.equal(st.failed, 0, 'the retry was answered');
assert.equal(st.error, '');
assert.equal(keys().filter(k => k.startsWith('b:')).length, 100, 'b has its second page');
assert.equal(new Set(keys()).size, keys().length, 'no row twice');
while (M.reviewQueryState().more) await M.moreQueriedReviews(F);
assert.equal(keys().length, 240, 'every file of both teams once: no gap');
// a team that fails its FIRST page is retried from the start
F = { q: 'first-page-fails' };
failOnce.add('a:'); asked = [];
await M.queryReviews(F);
st = M.reviewQueryState();
assert.equal(st.failed, 1); assert.equal(keys().filter(k => k.startsWith('a:')).length, 0);
await M.retryQueriedReviews(F);
assert.equal(M.reviewQueryState().failed, 0); assert.equal(keys().filter(k => k.startsWith('a:')).length, 50, 'its first page, by the retry');
assert.equal(M.reviewQueryState().total, 240, 'the total is each team once');

// 3: a row settled while the answer was on its way does not come back
F = { q: 'settle-race' };
let release; hold = { team: 'a', promise: new Promise(r => { release = r; }) };
const pending = M.queryReviews(F);
await settle();
M.settleReview({ team: 'a', id: 'a-3', reviewKey: 'a:a-3', name: 'file-003.md' }); // the Operator approved it meanwhile
release(); hold = null; await pending;
assert.ok(!keys().includes('a:a-3'), 'the settled row did not reappear from the query that was in flight');
assert.ok(keys().includes('a:a-4'), 'the others did arrive');
// and a Show more in flight: hold team a's second page, settle one of its rows while it is on its way, release it
let release2; hold = { team: 'a', cursor: '50|', promise: new Promise(r => { release2 = r; }) };
assert.ok(keys().includes('a:a-4') && !keys().includes('a:a-60'), 'a-60 is on the second page of team a, not yet read');
const more = M.moreQueriedReviews(F);
await settle();
M.settleReview({ team: 'a', id: 'a-60', reviewKey: 'a:a-60', name: 'x' }); // the Operator approved it while the page was on its way
release2(); hold = null; await more;
assert.ok(!keys().includes('a:a-60'), 'the settled row did not come back with the Show more that was in flight');
assert.ok(keys().includes('a:a-61'), 'the rest of the page did arrive');
// 4 (#13366, round 3 SHOULD a): the frozen parameters are the WHOLE query, not only `until`: every page of a walk, first and later, of every team, sends the same q, by, until, sort, tag, limit and versions, though time passes between them
F = { q: 'frozen', agent: 'Dev', longer: '30', sort: 'oldest' };
asked = []; clock += 60000;
await M.queryReviews(F);
const firstParams = asked[0].params;
const expectedAt = new Date(clock - 30 * 60000).toISOString();
const want = new URLSearchParams({ tag: 'for review', limit: '50', versions: 'newest', q: 'frozen', by: 'Dev', until: expectedAt, sort: 'oldest' }); want.sort();
assert.equal(firstParams, want.toString(), 'the first page asks for the whole query: ' + firstParams);
clock += 7000; await M.moreQueriedReviews(F);
clock += 7000; await M.moreQueriedReviews(F);
assert.ok(asked.length >= 6, 'three pages of two teams were asked: ' + asked.length);
assert.deepEqual([...new Set(asked.map(a => a.params))], [firstParams], 'every page of the walk, whatever the time, sends the one set of parameters');

// 5 (#13366, SHOULD c): a team's total is its first page's: a computer that counts what is left on a later page does not shrink the total
F = { q: 'total-first-page' };
laterTotals = true; asked = [];
await M.queryReviews(F);
assert.equal(M.reviewQueryState().total, 240, 'the totals of both teams on their first pages');
await M.moreQueriedReviews(F);
assert.equal(M.reviewQueryState().total, 240, 'the total after Show more is still the first pages\' (a later page says 70 left for each team)');
await M.moreQueriedReviews(F);
assert.equal(M.reviewQueryState().total, 240, 'and after the last pages');
laterTotals = false;

// 6 (#13366, SHOULD b): a walk that was replaced while its answers were on the way folds nothing into the walk now shown: the new walk's rows, total and Show more are its own
F = { q: 'old-walk' };
let releaseOld; hold = { team: 'a', promise: new Promise(r => { releaseOld = r; }) };
const oldWalk = M.queryReviews(F);
await settle();
const G = { q: 'new-walk' }; hold = null;
await M.queryReviews(G); // a different filter starts over while the first walk's page of team a is still on its way
const newKeys = M.queriedReviews(G).map(r => r.reviewKey), newState = JSON.stringify(M.reviewQueryState());
releaseOld(); await oldWalk; await settle(); // the old walk's answers arrive now
assert.deepEqual(M.queriedReviews(G).map(r => r.reviewKey), newKeys, 'the old walk added no row to the new one');
assert.equal(JSON.stringify(M.reviewQueryState()), newState, 'nor changed its total, Show more or errors');
assert.equal(M.queriedReviews(F), null, 'the old filters are no longer the current query');

console.log('inbox_reviews_query: ok');
