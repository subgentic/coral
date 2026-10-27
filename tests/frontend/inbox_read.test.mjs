// The Inbox's read marker (#9687): read means opened, unread again when newer, the first use does not make old rows bold, bounded, never throws.
//   node inbox_read.test.mjs
import assert from 'node:assert/strict';
import { createReadMarker, READ_KEY, READ_MAX } from '../../coral-go/pkg/frontend/static/inbox_read.js';

const memory = () => { const m = new Map(); return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), m }; };
const T0 = Date.parse('2026-10-27T10:00:00Z'), min = n => new Date(T0 + n * 60000).toISOString();
let clock = T0;
const mk = store => createReadMarker(store, () => clock);

// first use: `since` is recorded; what is at or before it is read, what is newer is unread
let store = memory(); let r = mk(store);
assert.equal(r.isUnread('task', 'a#1', min(-5)), false, 'an old row is read on first use');
assert.equal(JSON.parse(store.get(READ_KEY)).since, T0, 'since is written on the first look');
clock = T0 + 10 * 60000;
assert.equal(r.isUnread('task', 'a#1', min(5)), true, 'a row newer than since and never opened is unread');
assert.equal(r.isUnread('task', 'a#1', min(0)), false, 'at since is read');
// opening marks it read at its stamp; a newer stamp is unread again; another kind or key is separate
r.markRead('task', 'a#1', min(5));
assert.equal(r.isUnread('task', 'a#1', min(5)), false, 'opened: read');
assert.equal(r.isUnread('task', 'a#1', min(7)), true, 'updated after it was opened: unread again');
assert.equal(r.isUnread('chat', 'a#1', min(5)), true, 'the kind is part of the key');
assert.equal(r.isUnread('task', 'a#2', min(5)), true, 'so is the key');
r.markRead('task', 'a#1', min(3));
assert.equal(r.isUnread('task', 'a#1', min(5)), false, 'an older mark never moves a newer one back');
// it survives a reload (another marker over the same store)
const r2 = mk(store);
assert.equal(r2.isUnread('task', 'a#1', min(5)), false, 'kept in the store');
assert.equal(r2.isUnread('task', 'a#1', min(8)), true);
// a stamp that is not a date is read, never bold on a guess
assert.equal(r.isUnread('task', 'x', 'soon'), false); assert.equal(r.isUnread('task', 'x', ''), false); assert.equal(r.isUnread('task', 'x', undefined), false);
// the count
assert.equal(r.unreadCount('task', [{ k: 'a#1', t: min(5) }, { k: 'a#2', t: min(5) }, { k: 'a#3', t: min(-1) }], x => x.k, x => x.t), 1, 'unreadCount counts the unread');
// corrupt storage reads as empty and is replaced; blocked storage never throws
store = memory(); store.set(READ_KEY, '{not json'); clock = T0;
r = mk(store); assert.equal(r.isUnread('task', 'a', min(-1)), false); assert.ok(JSON.parse(store.get(READ_KEY)).since === T0, 'a corrupt record is replaced');
store = memory(); store.set(READ_KEY, JSON.stringify({ since: 'x', items: [] })); r = mk(store); assert.equal(r.isUnread('task', 'a', min(-1)), false, 'a record of the wrong shape is replaced');
const blocked = { get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); } };
assert.throws(() => mk(blocked).isUnread('task', 'a', min(1)), /blocked/, 'a raw throwing store is the storage module\'s to catch (browserLocal never throws)');
const failing = { get: () => null, set: () => {} }; r = mk(failing); r.markRead('task', 'a', min(2)); // a store that drops writes: no throw
// bounded: the newest READ_MAX kept, the oldest dropped
store = memory(); r = mk(store);
for (let i = 0; i < READ_MAX + 50; i++) r.markRead('chat', 'c' + i, T0 + i * 1000);
const kept = JSON.parse(store.get(READ_KEY)).items;
assert.equal(Object.keys(kept).length, READ_MAX, 'bounded');
assert.ok(!('chat:c0' in kept) && ('chat:c' + (READ_MAX + 49) in kept), 'the oldest went, the newest stayed');
console.log('inbox_read: ok (first use, opened, newer, kind and key, reload, not a date, corrupt, bound)');
