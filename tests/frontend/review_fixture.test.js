// The shared visual-fixture server model is pure, source scoped and paged.
const assert = require('node:assert/strict');
const { reviewFixturePage: page, reviewFixtureDigest: digest, reviewFixtureURL } = require('./helpers/review_fixture');
const base = 'https://example.test/';
const hex = n => n.toString(16).padStart(64, '0');
const make = i => ({ id: 'display-' + i, uri: 'coral://artifacts/' + hex(i + 1), name: 'Doc ' + i, produced_by: i === 64 ? 'Late writer' : 'Writer', available: true, tags: ['for review'], created_at: new Date(1000 + i * 1000).toISOString(), ...(i === 64 ? { goal_id: 77, goal_title: 'Late goal' } : {}) });
const rows = Array.from({ length: 65 }, (_, i) => make(i));
const query = '/api/team-artifacts?tag=for%20review&versions=newest&starred_first=true&facets=team,by,goal&limit=50';
globalThis.fetch = () => { throw new Error('Fixture helpers must not fetch.'); };
const first = page(query, base, { alpha: { team: 'Product', artifacts: rows } });
assert.equal(first.artifacts.length, 50); assert.equal(first.total, 65); assert.equal(first.has_more, true);
assert.ok(first.artifacts.every(r => r.board_id === 'alpha' && r.team === 'Product' && /^[0-9a-f]{64}$/.test(r.id)));
assert.equal(first.tag_counts['for review'], 65);
assert.ok(first.facets.by.some(f => f.v === 'Late writer'), 'facets cover off-page rows');
assert.ok(first.facets.goal.some(f => f.id === 77));
const next = new URL(query, base); next.searchParams.set('cursor', first.next_cursor);
const second = page(next, base, { alpha: { team: 'Product', artifacts: rows } });
assert.equal(second.artifacts.length, 15); assert.equal(second.has_more, false);
assert.equal(new Set([...first.artifacts, ...second.artifacts].map(r => r.id)).size, 65);
const wrong = new URL(next); wrong.pathname = '/api/remote/other/api/team-artifacts';
assert.throws(() => page(wrong, base, { alpha: rows }), /another computer or query/);
const changed = new URL(next); changed.searchParams.set('q', 'different');
assert.throws(() => page(changed, base, { alpha: rows }), /another computer or query/);
assert.equal(page('/api/board/alpha/artifacts', base, { alpha: rows }), null, 'no weaker route is synthesized');
assert.equal(reviewFixtureURL(query, base).pathname, '/api/team-artifacts', 'global URL remains the actual protected URL');
assert.throws(() => page(query, base, { '@other/alpha': rows }), /raw board ids/);
const exact = page('/api/team-artifacts?team=alpha&digest=' + hex(65), base, { alpha: rows, beta: [make(0)] });
assert.equal(exact.total, 1); assert.equal(exact.artifacts[0].id, hex(65));
assert.equal(digest(rows[0]), hex(1));
const scoped = page('/api/team-artifacts?team=Product&facets=team', base, { alpha: { team: 'Product', artifacts: [make(0)] }, beta: { team: 'Other', artifacts: [make(1)] } });
assert.equal(scoped.total, 1); assert.deepEqual(scoped.facets.team.map(f => f.v).sort(), ['Other', 'Product'], 'team facet leaves its own filter out');
const sameGoals = page('/api/team-artifacts?facets=goal', base, { alpha: [{ ...make(0), goal_id: 1, goal_title: 'Same' }, { ...make(1), goal_id: 2, goal_title: 'Same' }] });
assert.deepEqual(sameGoals.facets.goal.map(f => f.id), [1, 2], 'equal goal titles retain separate numbers');
const attention = [
    { ...make(0), tags: ['for review', 'read'], version: 2, opened_version: 1 },
    { ...make(1), tags: ['for review', 'read'], version: 2, opened_version: 0 },
    { ...make(2), tags: ['for review', 'changes requested'] },
    { ...make(3), tags: ['for review', 'changes requested', 'read'], new_comments: 1 },
    { ...make(4), tags: ['for review', 'saved'] },
];
const counted = page('/api/team-artifacts?tag=for%20review&waiting=1&muted=0&versions=newest&limit=1', base, { alpha: attention });
assert.equal(counted.total, 2); assert.equal(counted.artifacts.length, 1, 'metadata counts the query, not its page');
const saved = page('/api/team-artifacts?tag=saved', base, { alpha: attention });
assert.equal(saved.tag_counts['for review'], 1, 'Saved intersection metadata');
const pinned = [1, 2, 3].map(n => ({ ...make(n), series_id: 'series', version: n, starred: n === 1, name: 'Same', opened_version: 1 }));
const pin = page('/api/team-artifacts?starred_first=true&versions=newest', base, { alpha: pinned });
assert.equal(pin.total, 1); assert.equal(pin.artifacts[0].version, 3); assert.equal(pin.artifacts[0].starred, true);
assert.deepEqual(pin.artifacts[0].earlier_digests.sort(), pinned.slice(0, 2).map(digest).sort());
console.log('review_fixture: protected pages, raw identities, independent cursors, authoritative counts/facets and pinned versions pass without requests');
