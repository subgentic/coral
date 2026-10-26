// The one filter model (#8069): what defineFilters makes from a declaration, field type by field type. Each list's own module is tested on its own (task_filters.test.js and the rest);
// this holds the shared rules once: clean, isFiltered (the sort alone does not narrow), isQuery, chips (a range is one chip, a flag has a fixed word), without and the kept filters.
import assert from 'node:assert/strict';
import { defineFilters, text, day, localMidnight } from '../../coral-go/pkg/frontend/static/filter_model.js';

assert.equal(text('  a\u0000b  ', 10), 'a b'); assert.equal(text('x'.repeat(9), 4), 'xxxx'); assert.equal(text(5, 4), ''); assert.equal(text(undefined, 4), '');
assert.equal(day('2026-10-26'), '2026-10-26'); assert.equal(day('2026-13-01'), ''); assert.equal(day('2026-1-1'), ''); assert.equal(day(7), '');
assert.equal(localMidnight('2026-10-26'), new Date(2026, 9, 26).toISOString()); assert.equal(localMidnight('2026-10-31', 1), new Date(2026, 10, 1).toISOString());

const KINDS = ['a', 'b'];
const m = defineFilters({
    q: { type: 'text', max: 5 },
    kind: { type: 'choice', values: KINDS, chip: v => `Kind: ${v}` },
    kept: { type: 'flag', chip: 'Kept' },
    dates: { type: 'range', from: 'from', to: 'to', chip: (a, b) => `${a || '…'}–${b || '…'}` },
    goal: { type: 'custom', empty: '', clean: v => (/^\d+$/.test(v) ? v : ''), filtered: v => !!v, chip: v => `Goal ${v}` },
    sort: { type: 'order', values: ['new', 'old'], default: 'new' },
});
assert.deepEqual(m.EMPTY, { q: '', kind: '', kept: false, from: '', to: '', goal: '', sort: 'new' });
assert.deepEqual(m.clean(null), m.EMPTY); assert.deepEqual(m.clean('x'), m.EMPTY);
assert.deepEqual(m.clean({ q: ' toolong ', kind: 'z', kept: 'true', from: '2026-10-09', to: '2026-10-01', goal: 'x', sort: 'q' }), { q: 'toolo', kind: '', kept: false, from: '2026-10-01', to: '2026-10-09', goal: '', sort: 'new' }, 'bad values go; a reversed range is put the right way round');
assert.equal(m.isFiltered(m.EMPTY), false); assert.equal(m.isFiltered({ ...m.EMPTY, sort: 'old' }), false, 'the sort alone does not narrow');
for (const f of [{ q: 'a' }, { kind: 'a' }, { kept: true }, { from: '2026-10-01' }, { to: '2026-10-01' }, { goal: '3' }]) assert.equal(m.isFiltered({ ...m.EMPTY, ...f }), true, JSON.stringify(f));
assert.equal(m.isQuery(m.EMPTY), false); assert.equal(m.isQuery({ ...m.EMPTY, sort: 'old' }), true, 'a sort that is not the default is a query'); assert.equal(m.isQuery({ ...m.EMPTY, kind: 'b' }), true);
assert.deepEqual(m.chips({ ...m.EMPTY, q: 'x' }), [], 'a field with no chip has none (the box shows it)');
assert.deepEqual(m.chips({ ...m.EMPTY, kind: 'a', kept: true, from: '2026-10-01', goal: '4' }), [{ key: 'kind', label: 'Kind: a' }, { key: 'kept', label: 'Kept' }, { key: 'dates', label: '2026-10-01–…' }, { key: 'goal', label: 'Goal 4' }], 'in declaration order; a range is one chip');
assert.deepEqual(m.chips({ ...m.EMPTY, sort: 'old' }), [], 'the sort is never a chip');
assert.deepEqual(m.without({ ...m.EMPTY, from: 'x', to: 'y', kind: 'a', kept: true, goal: '2', sort: 'old' }, 'dates'), { ...m.EMPTY, kind: 'a', kept: true, goal: '2', sort: 'old', from: '', to: '' }, 'a range clears both days');
assert.equal(m.without({ ...m.EMPTY, kept: true }, 'kept').kept, false); assert.equal(m.without({ ...m.EMPTY, goal: '2' }, 'goal').goal, ''); assert.equal(m.without({ ...m.EMPTY, sort: 'old' }, 'sort').sort, 'new', 'the sort goes back to its default');

// kept filters: stored while they are a query, removed otherwise; a bad store or id gives the empty ones
const store = () => { const d = new Map(); return { d, get: k => (d.has(k) ? d.get(k) : null), set: (k, v) => d.set(k, v), remove: k => d.delete(k) }; };
const kept = m.persist(id => `k:${id}`);
const s = store();
kept.save('b1', { ...m.EMPTY, kind: 'a' }, s); assert.deepEqual(kept.load('b1', s), { ...m.EMPTY, kind: 'a' });
kept.save('b1', m.EMPTY, s); assert.equal(s.d.size, 0, 'the empty filters are not kept'); kept.save('b1', { ...m.EMPTY, sort: 'old' }, s); assert.equal(s.d.size, 1, 'a sort that is not the default is kept');
assert.deepEqual(kept.load('', s), m.EMPTY); assert.deepEqual(kept.load('b1', null), m.EMPTY);
s.d.set('k:b2', '{broken'); assert.deepEqual(kept.load('b2', s), m.EMPTY);
console.log('filter_model: ok');
