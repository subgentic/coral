// #13172 (slice 2a): review_counts.js asks each computer's own list for how many files wait, so the badge needs no page read; ask_filter.unreadReviewCount is the full read's number once it has run, else the counted one, else 0.
import assert from 'node:assert/strict';

globalThis.location = new URL('https://hub.test/');
let asked = [], answers = {}, clock = 1e12;
Date.now = () => clock;
globalThis.window = { __coral: {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };
globalThis.fetch = async (url) => {
    const u = new URL(String(url), location.href); asked.push(u.pathname + u.search);
    const m = /^\/api\/remote\/([^/]+)\//.exec(u.pathname), id = m ? m[1] : 'local';
    const a = answers[id];
    if (!a) return Response.json({}, { status: 500 });
    return a.status ? Response.json({ error: 'unknown parameter' }, { status: a.status }) : Response.json({ total: a.total, artifacts: [] });
};
const { state } = await import('../../coral-go/pkg/frontend/static/state.js');
let seq = 0;
const fresh = () => import('../../coral-go/pkg/frontend/static/review_counts.js?run=' + (++seq)); // a new module instance: nothing read yet
let C = await fresh();
const F = await import('../../coral-go/pkg/frontend/static/ask_filter.js');

// before anything is read: unknown, and the badge says 0
assert.equal(C.countedUnread(), null);
F.setReviewCounter(() => C.countedUnread()); // the bridge reads whichever instance is current
assert.equal(F.unreadReviewCount(), 0, 'nothing known: 0');

// this computer alone: one read, the count of its own list's waiting files, none of its pages
state.hub = false; answers.local = { total: 7 };
assert.equal(await C.refreshCounts(), true, 'the number changed (null to 7)');
assert.equal(C.countedUnread(), 7);
assert.equal(asked.length, 1, 'one request');
assert.equal(asked[0], C.COUNT_PATH);
const q = new URL(asked[0], 'http://x').searchParams;
assert.equal(q.get('waiting'), '1'); assert.equal(q.get('muted'), '0'); assert.equal(q.get('versions'), 'newest'); assert.equal(q.get('limit'), '1'); assert.equal(q.get('tag'), 'for review');
assert.equal(F.unreadReviewCount(), 7, 'the badge reads the counted number before the Inbox was ever opened');

// at most once in 30 s
asked = []; clock += 10000;
assert.equal(await C.refreshCounts(), false); assert.equal(asked.length, 0, 'within 30 s: no new read');
clock += 21000; answers.local = { total: 9 };
assert.equal(await C.refreshCounts(), true); assert.equal(C.countedUnread(), 9);

// a hub with computers: each one's count, summed; an offline one is not asked
C = await fresh(); asked = [];
state.hub = true; state.servers = [{ id: 'box-2', status: 'online' }, { id: 'box-3', status: 'offline' }]; answers['box-2'] = { total: 5 };
await C.refreshCounts();
assert.equal(C.countedUnread(), 14, 'this computer 9 + box-2 5');
assert.ok(asked.some(p => p.startsWith('/api/remote/box-2/api/team-artifacts?')), 'box-2 through the proxy');
assert.ok(!asked.some(p => p.includes('box-3')), 'an offline computer is not asked');

// a computer too old to know the words (it refuses them) or that does not answer: unknown, never a wrong number
C = await fresh(); answers['box-2'] = { status: 400 };
await C.refreshCounts();
assert.equal(C.countedUnread(), null, 'one computer refused: the number is not known');
assert.equal(F.unreadReviewCount(), 0, 'and with no full read the badge shows 0, as it always did');

// once the full read has run, its rows are the count (the page's own rules), even while a counted number is there
answers['box-2'] = { total: 1 }; C = await fresh(); await C.refreshCounts();
assert.equal(C.countedUnread(), 10);
F.setReviewCacheReader(() => [1, 2, 3, 4], () => null, () => true);
assert.equal(F.unreadReviewCount(), 4, 'the full read wins once it has run');
F.setReviewCacheReader(() => [1, 2, 3, 4], () => null, () => false);
assert.equal(F.unreadReviewCount(), 10, 'before the full read it is the counted number (this computer 9 + box-2 1)');
console.log('review_counts: ok');
