// "#8" in a question's text is a reference to message 8 (#14153): the rules of splitMessageRefs, case by case, so a change to one of them is a failing test (QA Reviewer 2's mutants: a letter or digit before the "#", a leading zero).
import assert from 'node:assert/strict';
import { splitMessageRefs } from '../../coral-go/pkg/frontend/static/message_refs.js';

const ids = text => splitMessageRefs(text).filter(p => p.id).map(p => p.id);
const rebuilt = text => splitMessageRefs(text).map(p => p.id ? `#${p.id}` : p.text).join('');

assert.deepEqual(ids('You approved #8 and your #6 answer'), [8, 6], 'plain references');
assert.deepEqual(ids('see (#7), #8. and "#9" and [#10]'), [7, 8, 9, 10], 'after a bracket, a quote, before a full stop');
assert.deepEqual(ids('#5 first thing'), [5], 'at the start');
assert.deepEqual(ids('abc#8'), [], 'a letter before the # is not a reference (mutant)');
assert.deepEqual(ids('x1#8 and 12#13'), [], 'a digit or a word before the # is not a reference (mutant)');
assert.deepEqual(ids('#08 and #0 and #00'), [], 'a leading zero or zero is not a reference (mutant)');
assert.deepEqual(ids('#8abc and #9_x and #10-b'), [], 'a number glued to a word is not a reference');
assert.deepEqual(ids('&#8; and ##8 and /#8'), [], 'an entity, a double hash and a path are not references');
assert.deepEqual(ids('#123456789 and #1234567890'), [123456789], 'at most nine digits');
for (const word of ['task', 'Task', 'goal', 'Goal', 'issue', 'step', 'PR', 'pull request', 'item', 'number', 'no.', 'bug', 'finding', 'row', 'point']) assert.deepEqual(ids(`the ${word} #12 is not a message`), [], `${word} #12 names something else`);
assert.deepEqual(ids('task #12 and then #13'), [13], 'only the one after the word is skipped');
assert.deepEqual(ids('tasks #12'), [], 'plural too');
for (const text of ['You approved #8 and your #6 answer', 'abc#8 #08 (#7).', 'task #12 and #13', '#5', '']) assert.equal(rebuilt(text), text, 'the words around a reference are kept exactly: ' + JSON.stringify(text));
console.log('PASS message_refs: plain, bracketed, glued, zero, long and after-word cases');
