// The $ menu's filter (#12677): a few letters are prefixes of the skill's name or of its parts, so "$re" finds release-notes before the route's whole-word search could. Name matches come first.
import assert from 'node:assert/strict';
import { filterSkills } from '../../coral-go/pkg/frontend/static/skill_filter.js';

const S = [
    { name: 'release-notes', description: 'Write the release notes' },
    { name: 'abstract-review', description: 'Review a change for what it hides' },
    { name: 'abacus-math', description: 'Do sums with care' },
    { name: 'db-review', description: 'Checks a SQL migration' },
    { name: 'creating-coral-skills', description: 'How to write a skill for Coral' },
];
const names = (w, l = S) => filterSkills(l, w).map(s => s.name);
assert.deepEqual(names(''), S.map(s => s.name), 'no words: all of them, in order');
assert.deepEqual(names('re'), ['release-notes', 'abstract-review', 'db-review', 'creating-coral-skills'], 're: a name that starts with it first, then a name part (review), then letters inside a name (c-re-ating)');
assert.deepEqual(names('ab'), ['abstract-review', 'abacus-math']);
assert.deepEqual(names('AB'), ['abstract-review', 'abacus-math'], 'case does not matter');
assert.deepEqual(names('rev'), ['abstract-review', 'db-review'], 'a part of the name');
assert.deepEqual(names('rev ab'), ['abstract-review'], 'every word must start a part');
assert.deepEqual(names('migr'), ['db-review'], 'a word of the description');
assert.deepEqual(names('cr'), ['creating-coral-skills'], 'cr: the real search finds nothing for it, a prefix does');
assert.deepEqual(names('stract'), ['abstract-review'], 'inside the name, after the prefix kinds');
assert.deepEqual(names('PATH'), [], '$PATH names nothing');
assert.deepEqual(names('x', []), []);
assert.equal(filterSkills([{ name: null, description: undefined }], 'a').length, 0, 'a skill with no words is not a match and does not throw');
console.log('PASS skill_filter: prefixes of the name and its parts, then the description');
