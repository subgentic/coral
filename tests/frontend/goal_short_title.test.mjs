// A goal's short name (#15245, beta walk 12 H3/M6): the first clause of the title, at most 60 characters cut at a word, with the number agents write in front.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { shortTitle } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'goal_short.js')).href); // a file:// URL: a bare d:\\ path is refused on Windows
assert.equal(shortTitle('Build a todo app. It should add, edit and remove items and keep them in a file.'), 'Build a todo app');
assert.equal(shortTitle('Ship the beta: every tester finishes an app'), 'Ship the beta');
assert.equal(shortTitle('Make onboarding calmer - fewer steps'), 'Make onboarding calmer');
assert.equal(shortTitle('Short one'), 'Short one');
const long = shortTitle('add a very long list of features to the app so that a person can keep track of everything they need to do in a week');
assert.ok(long.length <= 61 && long.endsWith('…') && !/ …$/.test(long), long);
assert.notEqual(shortTitle('Add a settings page for the first feature that the team wants to build next week please'), shortTitle('Add a settings page for the second feature that the team wants to build next week please'), 'two long goals from one sentence stay apart only if the cut allows it, else the number does');
console.log('goal_short_title ok');
