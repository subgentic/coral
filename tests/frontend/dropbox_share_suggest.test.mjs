// Address suggestions in the Share via Dropbox dialog (#16170): the address being typed is found between separators, a suggestion replaces only that address, and an address already in the box is not offered again.
import assert from 'node:assert/strict';
import { tokenAt, applySuggestion, typedAddresses } from '../../coral-go/pkg/frontend/static/dropbox_share.js';

assert.deepEqual(tokenAt('', 0), { start: 0, end: 0, text: '' });
assert.equal(tokenAt('ana@x.org\nsa', 12).text, 'sa', 'the second line');
assert.equal(tokenAt('ana@x.org, sa', 13).text, 'sa', 'after a comma and a space');
assert.equal(tokenAt('ana@x.org;sam@y.org', 4).text, 'ana@x.org', 'the caret in the first of two');
assert.equal(tokenAt('a;b;c', 3).text, 'b', 'the middle one');

let r = applySuggestion('ana@x.org\nsa', 12, 'sam@y.org');
assert.deepEqual(r, { value: 'ana@x.org\nsam@y.org\n', pos: 20 }, 'the typed part is replaced, a new line follows');
r = applySuggestion('sa, lee@z.org', 2, 'sam@y.org');
assert.equal(r.value, 'sam@y.org\nlee@z.org', 'what follows is kept, on its own line');
assert.equal(r.pos, 10);
r = applySuggestion('', 0, 'ana@x.org');
assert.equal(r.value, 'ana@x.org\n');

assert.deepEqual(typedAddresses('Ana@X.org, sam@y.org\n\n'), ['ana@x.org', 'sam@y.org'], 'lower-cased, empties dropped');
console.log('dropbox_share_suggest: the typed address, the replacement and the already-typed set');
