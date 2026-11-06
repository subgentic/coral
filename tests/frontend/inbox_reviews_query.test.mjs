// #13162, UI Reviewer's three MUSTs on the filtered Needs you walk, with the real module and a stub computer that validates cursors the way the server does (its cursor is bound to the query's parameters, until included):
//  1 the parameters (and the time of waited-longer-than) are made once for a walk, so Show more is not refused;
//  2 a team whose page failed keeps its cursor, Show more and Retry ask it again, no gap and no repeat;
//  3 a row the Operator settled while an answer was on its way does not come back from it.
import assert from 'node:assert/strict';

let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
Date.now = () => clock;
const hex = i => i.toString(16).padStart(64, 'c');
const art = (i, pre = 'a-') => ({ id: pre + i, uri: 'coral://artifacts/' + hex(i), tags: ['for review'], name: `file-${String(i).padStart(3, '0')}.md`, created_at: new Date(Date.UTC(2026, 10, 4) - i * 1000).toISOString(), available: true, produced_by: 'Dev', session_id: 's-1' });
const TEAMS = { a: Array.from({ length: 120 }, (_, i) => art(i)), b: Array.from({ length: 120 }, (_, i) => art(1000 + i)) };
let failOnce = new Set(), asked = [], hold = null;
globalThis.fetch = async (url) => {
    const u = new URL(url, 'http://localhost'), p = u.pathname;
    if (p === '/api/board/projects') return Response.json([{ project: 'a' }, { project: 'b' }]);
    const m = /^\/api\/board\/(a|b)\/artifacts$/.exec(p);
    if (!m) return Response.json({});
    const team = m[1], tag = u.searchParams.get('tag');
    if (tag === 'saved') return Response.json({ artifacts: [], has_more: false });
    const cursor = u.searchParams.get('cursor') || '', until = u.searchParams.get('until') || '';
    asked.push({ team, cursor, until, params: [...u.searchParams].filter(([k]) => k !== 'cursor').map(([k, v]) => k + '=' + v).sort().join('&') });
    if (hold && hold.team === team && (hold.cursor === undefined ? !cursor : cursor.startsWith(hold.cursor))) await hold.promise;
    if (failOnce.has(team + ':' + cursor)) { failOnce.delete(team + ':' + cursor); return Response.json({}, { status: 503 }); }
    let start = 0;
    if (cursor) { const [at, boundUntil] = cursor.split('|'); if (boundUntil !== until) return Response.json({ error: 'invalid cursor' }, { status: 400 }); start = Number(at); } // the server's fingerprint includes until
    const qq = u.searchParams.get('q') || '';
    let page = TEAMS[team].slice(start, start + 50); const more = start + 50 < TEAMS[team].length;
    if (qq.startsWith('stale-')) page = page.map(a => ({ ...a, id: qq + '-' + a.id })); // a query's own files, so one answer can be told from another's
    const total = qq.startsWith('total-') && cursor ? 999 : TEAMS[team].length; // a later page that reports another total: the team's total is its first page's
    return Response.json({ artifacts: page, has_more: more, total, ...(more ? { next_cursor: `${start + 50}|${until}` } : {}) });
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
{ const walk = asked.filter(a => a.until); assert.ok(walk.some(a => a.cursor) && walk.some(a => !a.cursor));
    assert.equal(new Set(walk.map(a => a.params)).size, 1, 'every request of the walk, first pages and later ones, sent the same parameters (not only the same until): ' + [...new Set(walk.map(a => a.params))].join(' | ')); }
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

// (b) a walk that was replaced does not write into its replacement: query 'stale-one' is held, 'stale-two' starts and finishes, then 'stale-one' answers
let releaseOne; hold = { team: 'a', promise: new Promise(r => { releaseOne = r; }) };
const first = M.queryReviews({ q: 'stale-one' });
await settle();
hold = null;
await M.queryReviews({ q: 'stale-two' });
releaseOne(); await first;
const twoKeys = M.queriedReviews({ q: 'stale-two' }).map(r => r.reviewKey);
assert.ok(twoKeys.length > 0 && twoKeys.every(k => k.includes('stale-two')), 'the second query holds only its own files: ' + twoKeys.filter(k => !k.includes('stale-two')).slice(0, 3));
assert.equal(M.reviewQueryState().total, 240, 'and its own total');
// (c) a team's total is its first page's: a later page that reports another number does not change it
F = { q: 'total-check' };
await M.queryReviews(F);
assert.equal(M.reviewQueryState().total, 240);
await M.moreQueriedReviews(F);
assert.equal(M.reviewQueryState().total, 240, "the totals of later pages (999 here) are not the team's total");

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
console.log('inbox_reviews_query: ok');
