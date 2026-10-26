// The Team Artifacts panel's filters (#4573), on their own: what is accepted, how they become the list route's query, the chips, and the per-board memory (which must survive a store that throws).
//   node team_artifact_filters.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
    const m = await import(pathToFileURL(path.resolve(__dirname, '../../coral-go/pkg/frontend/static/team_artifact_filters.js')).href);

    // clean: anything unknown becomes empty; dates are real days; a reversed range is put the right way round; strings are cut and stripped of control characters
    assert.deepEqual(m.clean(undefined), m.EMPTY);
    assert.deepEqual(m.clean({ kind: 'video', origin: 'nowhere', sort: 'random', kept: 'yes', from: '2026-13-40', to: 'soon', q: 5, by: {} }), m.EMPTY);
    assert.deepEqual(m.clean({ from: '2026-10-09', to: '2026-10-05' }), { ...m.EMPTY, from: '2026-10-05', to: '2026-10-09' });
    assert.equal(m.clean({ q: 'a\u0000b\nc ' + 'x'.repeat(300) }).q.length, 200);
    assert.equal(m.clean({ q: ' a\tb ' }).q, 'a b');
    assert.equal(m.clean({ kept: true }).kept, true);

    // toParams: nothing for an empty filter but the sort; dates are local-midnight instants, until the next day's
    assert.deepEqual(m.toParams(m.EMPTY), { sort: 'newest' });
    assert.deepEqual(m.toParams({ ...m.EMPTY, q: 'zeb', kind: 'image', origin: 'received', by: 'Dev One', kept: true, sort: 'size' }), { q: 'zeb', kind: 'image', origin: 'received', by: 'Dev One', kept: 'true', sort: 'size' });
    const p = m.toParams({ ...m.EMPTY, from: '2026-10-05', to: '2026-10-09' });
    assert.equal(p.since, new Date(2026, 9, 5).toISOString()); assert.equal(p.until, new Date(2026, 9, 10).toISOString());
    assert.equal(m.toParams({ ...m.EMPTY, to: '2026-12-31' }).until, new Date(2027, 0, 1).toISOString(), 'the last day of the year ends at the next year\'s midnight');

    // Group by, Task and Goal (#8593): a task or goal is a positive whole number, the server's task and goal parameters; the grouping is how the list is read, never a filter
    assert.deepEqual(m.clean({ task: '12', goal: 7, group: 'goal' }), { ...m.EMPTY, task: '12', goal: '7', group: 'goal' });
    assert.deepEqual(m.clean({ task: '0', goal: '-3', group: 'week' }), m.EMPTY); assert.deepEqual(m.clean({ task: '1e3', goal: 'abc' }), m.EMPTY); assert.equal(m.clean({ task: '007' }).task, '7');
    assert.deepEqual(m.toParams({ ...m.EMPTY, task: '12', goal: '7', group: 'task' }), { task: '12', goal: '7', sort: 'newest' }, 'the grouping is not sent');
    assert.equal(m.isFiltered({ ...m.EMPTY, group: 'task' }), false, 'a grouping alone does not narrow'); assert.equal(m.isFiltered({ ...m.EMPTY, goal: '7' }), true);
    assert.deepEqual(m.chips({ ...m.EMPTY, group: 'task' }), [], 'no chip for a grouping');
    assert.deepEqual(m.chips({ ...m.EMPTY, task: '12', goal: '7' }).map(c => c.label), ['Task: #12', 'Goal: #7'], 'the number until the page has seen the names');
    const seen = m.noteChoices([{ task_id: 12, task_title: 'Write it', goal_id: 7, goal_title: 'Ship the installer' }, { task_id: 3, task_title: '' }, { task_id: 0 }]);
    assert.deepEqual(seen, { tasks: [['3', '#3'], ['12', '#12 Write it']], goals: [['7', 'Ship the installer']] });
    assert.deepEqual(m.chips({ ...m.EMPTY, task: '12', goal: '7' }).map(c => c.label), ['Task: #12 Write it', 'Goal: Ship the installer']);
    assert.equal(m.without({ ...m.EMPTY, goal: '7' }, 'goal').goal, ''); m.forgetChoices();

    // Tag (#8594): one of the team's tags, as the server stores it; it is the route's tag parameter and has its chip
    assert.equal(m.clean({ tag: '  For   Review ' }).tag, 'for review'); assert.equal(m.clean({ tag: 'a'.repeat(25) }).tag, ''); assert.equal(m.clean({ tag: 'no/slash' }).tag, ''); assert.equal(m.clean({ tag: 'ready-2' }).tag, 'ready-2');
    assert.deepEqual(m.toParams({ ...m.EMPTY, tag: 'for review' }), { tag: 'for review', sort: 'newest' });
    assert.deepEqual(m.chips({ ...m.EMPTY, tag: 'internal' }).map(c => c.label), ['Tag: internal']); assert.equal(m.isFiltered({ ...m.EMPTY, tag: 'internal' }), true);

    // the editor's normalizer is the server's (internal/board/artifact_tags.go): characters, not UTF-16 units; a decimal digit only
    const { normalizeTag } = await import(pathToFileURL(path.resolve(__dirname, '../../coral-go/pkg/frontend/static/artifact_tag_rules.js')).href);
    for (const [input, want] of [['x'.repeat(24), 'x'.repeat(24)], ['x'.repeat(25), ''], ['\u{1D4D0}'.repeat(24), '\u{1D4D0}'.repeat(24)], ['\u{1D4D0}'.repeat(25), ''], ['a\u00b2', ''], ['\u00bd', ''], ['\u0663', '\u0663'], ['a_b', ''], ['a/b', ''], ['  Two   Words ', 'two words'], ['ready-2', 'ready-2'], ['', ''], ['   ', '']]) assert.equal(normalizeTag(input), want, JSON.stringify(input));

    // chips and removing them
    assert.deepEqual(m.chips(m.EMPTY), []);
    const f = { ...m.EMPTY, q: 'x', kind: 'pdf', origin: 'unlisted', by: 'Dev', kept: true, from: '2026-10-01', to: '2026-10-02' };
    assert.deepEqual(m.chips(f).map(c => c.key), ['q', 'kind', 'origin', 'by', 'kept', 'dates']);
    assert.deepEqual(m.chips(f).map(c => c.label), ['Search: x', 'Type: PDF', 'Origin: Unlisted', 'By: Dev', 'Kept', '2026-10-01 to 2026-10-02']);
    assert.deepEqual(m.chips({ ...m.EMPTY, from: '2026-10-01' }).map(c => c.label), ['From 2026-10-01']);
    assert.deepEqual(m.without(f, 'dates'), { ...f, from: '', to: '' }); assert.equal(m.without(f, 'kept').kept, false); assert.equal(m.without(f, 'kind').kind, '');
    assert.equal(m.isFiltered(m.EMPTY), false); assert.equal(m.isFiltered({ ...m.EMPTY, sort: 'name' }), false, 'the sort alone does not narrow the list'); assert.equal(m.isFiltered(f), true);

    // the memory: per board, validated on the way back, and a store that throws changes nothing
    const mem = new Map();
    const store = { get: k => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v), remove: k => mem.delete(k) };
    m.saveFilters('board-a', { ...m.EMPTY, q: 'golf', sort: 'name' }, store);
    assert.deepEqual(m.loadFilters('board-a', store), { ...m.EMPTY, q: 'golf', sort: 'name' });
    assert.deepEqual(m.loadFilters('board-b', store), m.EMPTY, 'another board starts empty');
    m.saveFilters('board-a', m.EMPTY, store); assert.equal(mem.size, 0, 'nothing kept for an empty search');
    mem.set(m.storageKey('board-a'), '{not json'); assert.deepEqual(m.loadFilters('board-a', store), m.EMPTY);
    mem.set(m.storageKey('board-a'), JSON.stringify({ kind: 'video', q: 'ok' })); assert.deepEqual(m.loadFilters('board-a', store), { ...m.EMPTY, q: 'ok' });
    const bad = { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('blocked'); }, remove: () => { throw new Error('blocked'); } };
    assert.deepEqual(m.loadFilters('board-a', bad), m.EMPTY); assert.doesNotThrow(() => m.saveFilters('board-a', { ...m.EMPTY, q: 'x' }, bad));
    assert.deepEqual(m.loadFilters(null, store), m.EMPTY);
    console.log('team_artifact_filters: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
