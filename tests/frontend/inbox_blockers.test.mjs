// What waits on a Needs you item (#11442, #11455): the server's waits_on_this ({ count, top_title, priority, closes_goal }, counted across every board) read into the info the phrases use, the phrases ("High priority: 3 tasks
// wait on this", "Blocks 3 tasks", "Closes goal ..."), and the weight that sorts blockers first. A row without the field says nothing. Pure functions.
//   node inbox_blockers.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const B = await importUi('inbox_blockers');
const { markHidden } = await importUi('visible_marks');

// the field into the info
for (const none of [null, undefined, '', 'x', 7, {}, { count: 0 }, { count: -2 }, { count: 'many' }, { top_title: 'Tag', priority: 'high' }]) assert.equal(B.infoOf(none), null, 'nothing waits and no goal closes: ' + JSON.stringify(none));
const three = B.infoOf({ count: 3, top_title: 'Tag v2.0.10', priority: 'high' });
assert.deepEqual(three, { count: 3, first: 'Tag v2.0.10', high: true, closes: '' });
assert.equal(B.infoOf({ count: '2', priority: 'critical' }).count, 2, 'a count sent as text is a number');
assert.equal(B.infoOf({ count: 2, priority: 'critical' }).high, true); assert.equal(B.infoOf({ count: 2, priority: 'medium' }).high, false); assert.equal(B.infoOf({ count: 2, priority: 'low' }).high, false); assert.equal(B.infoOf({ count: 2 }).high, false);
const closes = B.infoOf({ count: 0, closes_goal: 'Checkout redesign' });
assert.deepEqual(closes, { count: 0, first: '', high: false, closes: 'Checkout redesign' }, 'a goal the item would close, with nothing waiting');
const one = B.infoOf({ count: 1, top_title: 'Tag batch-88 release', priority: 'medium' });

// the phrases
assert.equal(B.phraseOf(three), 'High priority: 3 tasks wait on this');
assert.equal(B.phraseOf(one), '“Tag batch-88 release” waits on this', 'one waiter is named');
assert.equal(B.phraseOf(closes), 'Closes goal “Checkout redesign”');
assert.equal(B.phraseOf(B.infoOf({ count: 2, priority: 'medium', closes_goal: 'Solo' })), '2 tasks wait on this · closes goal “Solo”');
assert.equal(B.phraseOf(null), '');
assert.equal(B.shortPhraseOf(three), 'Blocks 3 tasks'); assert.equal(B.shortPhraseOf(one), 'Blocks “Tag batch-88 release”'); assert.equal(B.shortPhraseOf(closes), 'Closes a goal'); assert.equal(B.shortPhraseOf(null), '');

// a title is an agent's text: the caller's marker writes out what hides or reorders it; a title that marks to nothing is "a task" or "a goal"
{
    const mark = x => markHidden(x, { strict: true }), hid = B.infoOf({ count: 1, top_title: 'Tag‮ v2​', priority: 'medium' });
    assert.equal(B.phraseOf(hid, mark), '“Tag<U+202E> v2<U+200B>” waits on this', 'a title that hides or reorders text is written out, not drawn');
    assert.equal(B.shortPhraseOf(hid, mark), 'Blocks “Tag<U+202E> v2<U+200B>”');
    assert.equal(B.phraseOf(B.infoOf({ count: 1, top_title: '‮', priority: 'medium' }), () => ''), '“a task” waits on this');
    assert.equal(B.phraseOf(B.infoOf({ count: 0, closes_goal: '‮' }), () => ''), 'Closes goal “a goal”');
}

// the weight: a high-priority waiter first, then the count, then a goal that closes; nothing is 0
const w = B.weightOf;
assert.ok(w(three) > w(one) && w(one) > w(closes) && w(closes) > 0 && w(null) === 0, 'blockers sort by weight');
assert.ok(w(B.infoOf({ count: 1, priority: 'high' })) > w(B.infoOf({ count: 9, priority: 'medium' })), 'one high-priority waiter outweighs nine ordinary ones');
console.log('inbox_blockers: ok');
