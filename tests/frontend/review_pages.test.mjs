import assert from 'node:assert/strict';
import { createReviewPages } from '../../coral-go/pkg/frontend/static/review_pages.js';
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const row = (team, id) => ({ team, id });
const key = r => `${r.team}:${r.id}`;
const page = (artifacts, extra = {}) => ({ artifacts, has_more: false, total: artifacts.length, ...extra });

// Initial reads are bounded and never follow cursors without a person's request.
const asked = [];
const pager = createReviewPages({ key, read: async (server, options) => {
    asked.push({ server, ...options });
    if (!options.cursor) return page([row('alpha', 'same')], { total: 75, has_more: true, next_cursor: server + '-next', tag_counts: { read: 20 }, facets: { by: [{ v: 'Not on this page', n: 12 }] } });
    return page([row('alpha', 'same'), row('alpha', 'older')], { total: 75 });
} });
assert.equal(asked.length, 0, 'constructing a pager does not start the Inbox');
pager.reset(['one', 'two'], 'initial');
await Promise.all([pager.load(), pager.load()]);
assert.deepEqual(asked.map(r => [r.server, r.limit, r.cursor]), [['one', 50, ''], ['two', 50, '']]);
assert.deepEqual(pager.snapshot().map(s => [s.server, s.artifacts.length, s.total]), [['one', 1, 75], ['two', 1, 75]], 'computer totals are not derived from loaded rows; duplicate IDs on separate computers remain separate');
assert.equal(pager.snapshot()[0].facets.by[0].v, 'Not on this page');
await pager.more('two');
assert.equal(asked.at(-1).cursor, 'two-next');
assert.deepEqual(pager.snapshot().map(s => s.artifacts.length), [1, 2], 'append deduplicates only within its source and leaves other sources alone');
await pager.more('two');
assert.equal(asked.length, 3, 'an exhausted source is not asked again');

// One source failing cannot clear the other source, its own window, or its cursor.
let fail = true;
const retries = [];
const failures = createReviewPages({ key, read: async (server, options) => {
    retries.push([server, options.cursor]);
    if (!options.cursor) return page([row('team', 'first')], { total: 2, has_more: true, next_cursor: server + '-c' });
    if (server === 'bad' && fail) throw new Error('offline');
    return page([row('team', 'second')], { total: 2 });
} });
failures.reset(['bad', 'good']); await failures.load();
await Promise.all([failures.more('bad'), failures.more('good')]);
assert.equal(failures.snapshot()[0].error, 'offline');
assert.equal(failures.snapshot()[0].artifacts.length, 1);
assert.equal(failures.snapshot()[0].next_cursor, 'bad-c');
assert.equal(failures.snapshot()[1].artifacts.length, 2);
fail = false; await failures.more('bad');
assert.deepEqual(retries.filter(r => r[0] === 'bad').map(r => r[1]), ['', 'bad-c', 'bad-c']);
assert.equal(failures.snapshot()[0].error, '');

// A failed refresh of an exhausted window still has a working Retry action.
let unavailable = false;
const exhausted = createReviewPages({ key, read: async () => {
    if (unavailable) throw new Error('offline');
    return page([row('team', 'only')]);
} });
exhausted.reset(['box']); await exhausted.load();
unavailable = true; await exhausted.refresh();
assert.equal(exhausted.status()[0].has_more, false);
assert.equal(exhausted.status()[0].error, 'offline');
unavailable = false; await exhausted.more('box');
assert.equal(exhausted.status()[0].error, '');
assert.equal(exhausted.status()[0].loadedCount, 1);

// A server that ignores a cursor must not create an endless Show more loop.
const stalled = createReviewPages({ key, read: async () => page([row('team', 'x')], { has_more: true, next_cursor: 'unchanged' }) });
stalled.reset(['box']); await stalled.load(); await stalled.more('box');
assert.match(stalled.snapshot()[0].error, /new cursor/);
assert.equal(stalled.snapshot()[0].artifacts.length, 1);
assert.equal(stalled.snapshot()[0].next_cursor, 'unchanged');

// A late response to an old query cannot overwrite newer rows or totals.
const old = pending(), newer = pending(); let oldSignal;
const changing = createReviewPages({ key, read: (server, options) => {
    if (options.query === 'old') { oldSignal = options.signal; return old.promise; }
    return newer.promise;
} });
changing.reset(['box'], 'old'); const was = changing.load(); await Promise.resolve();
changing.reset(['box'], 'new'); const now = changing.load(); await Promise.resolve();
assert.equal(oldSignal.aborted, true);
newer.resolve(page([row('new', 'new')], { total: 900 })); await now;
old.resolve(page([row('old', 'old')], { total: 1 })); await was;
assert.equal(changing.snapshot()[0].artifacts[0].id, 'new');
assert.equal(changing.snapshot()[0].total, 900);
assert.equal(changing.snapshot()[0].loading, false);
// Reset before a queued read is dispatched must not send the old request with a new query.
const dispatched = [];
const queued = createReviewPages({ key, read: async (server, options) => { dispatched.push(options.query); return page([]); } });
queued.reset(['box'], 'old'); const cancelled = queued.load();
queued.reset(['box'], 'latest'); await queued.load(); await cancelled;
assert.deepEqual(dispatched, ['latest']);
await queued.more('unknown');
assert.equal(dispatched.length, 1, 'an unknown computer never falls back to local');

// Refresh keeps the whole loaded window published until all its pages answer.
let refreshing = false;
const second = pending(), enteredSecond = pending();
const retained = createReviewPages({ key, read: async (server, options) => {
    if (!refreshing) return options.cursor ? page([row('team', 'old-two')]) : page([row('team', 'old-one')], { has_more: true, next_cursor: 'next' });
    if (!options.cursor) return page([row('team', 'new-one')], { has_more: true, next_cursor: 'next' });
    enteredSecond.resolve(); return second.promise;
} });
retained.reset(['box']); await retained.load(); await retained.more('box');
refreshing = true; const replacement = retained.refresh(); await enteredSecond.promise;
assert.deepEqual(retained.snapshot()[0].artifacts.map(r => r.id), ['old-one', 'old-two'], 'page one of a refresh never shrinks the visible window');
second.resolve(page([row('team', 'new-two')])); await replacement;
assert.deepEqual(retained.snapshot()[0].artifacts.map(r => r.id), ['new-one', 'new-two']);
retained.remove(r => r.id === 'new-one');
assert.equal(retained.snapshot()[0].total, null, 'a local decision invalidates server counts rather than guessing them');
assert.deepEqual(retained.snapshot()[0].artifacts.map(r => r.id), ['new-two']);

console.log('review_pages: bounded first reads, isolated cursors, stable append/retry, authoritative metadata and stale-query rejection pass');
