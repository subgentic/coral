// The Guide's rules for a goal being written (#12724): the board's "how big a goal is" as local checks on the words. Each rule has a case that trips it and one that does not; no model is asked.
import assert from 'node:assert/strict';
import { assess, listItems, EXAMPLES, TASKS_MIN, TASKS_MAX } from '../../coral-go/pkg/frontend/static/goal_guide.js';

const one = a => a.checks.find(c => c.id === 'one'), done = a => a.checks.find(c => c.id === 'done');
// nothing written: todo, not warnings
let a = assess({});
assert.equal(one(a).state, 'todo'); assert.equal(done(a).state, 'todo'); assert.equal(a.looks, 0); assert.equal(a.size.state, 'todo');
// one outcome
assert.equal(one(assess({ title: 'The Messages tab loads earlier messages on scroll-up' })).state, 'ok');
for (const t of ['Importer is live and also Notion works', 'CSV import as well as Notion import', 'Add search plus filters']) assert.equal(one(assess({ title: t })).state, 'warn', t);
assert.match(one(assess({ title: 'CSV import as well as Notion' })).why, /as well as/);
assert.equal(one(assess({ title: 'Ship it', outcome: 'It reads CSV and also Notion.' })).state, 'warn', 'a second outcome in the description');
assert.equal(one(assess({ title: 'Fix login and logout and signup' })).state, 'warn', 'a title with several "and"');
assert.equal(one(assess({ title: 'Rewrite everything' })).state, 'warn', 'broad');
assert.equal(one(assess({ title: 'Release v1.4' })).state, 'warn', 'a release'); assert.match(one(assess({ title: 'Release v1.4' })).title, /release/);
assert.equal(one(assess({ title: 'Q3 roadmap' })).state, 'warn');
assert.equal(one(assess({ title: 'The platform team' })).state, 'warn', 'a team'); assert.match(one(assess({ title: 'The platform team' })).title, /team/);
assert.equal(one(assess({ title: 'The UI list' })).state, 'warn', 'the board\'s own example of too broad');
assert.equal(one(assess({ title: 'Customers import a CSV on their own' })).state, 'ok');
// done when
assert.equal(done(assess({ title: 'x', doneWhen: '' })).state, 'todo');
for (const d of ['It works well', 'The importer is better', 'Everything works', 'Feels good']) assert.equal(done(assess({ doneWhen: d })).state, 'warn', d);
for (const d of ['A new customer imports a 10,000-row CSV and sees every row in under a minute', 'A person can open Settings and see the Slack row']) assert.equal(done(assess({ doneWhen: d })).state, 'ok', d);
assert.equal(done(assess({ doneWhen: 'Numbers go up' })).state, 'warn', 'nothing to see and no number');
const chips = assess({ doneWhen: 'Imports a 10-row CSV and sees every row in under a minute and also Notion' }).chips.map(c => c.text);
assert.deepEqual(chips, ['Checkable', 'Has a number', 'Mentions two things']);
assert.deepEqual(assess({ doneWhen: 'It works well' }).chips.map(c => c.text), ['Hard to check', 'No number']);
// size
assert.equal(listItems('- a\n- b\n* c\n1. d\n[x] no\n  - e'), 5);
assert.equal(assess({ outcome: 'no list' }).size.state, 'todo');
assert.equal(assess({ outcome: '- one' }).size.state, 'low');
assert.equal(assess({ outcome: '- one\n- two\n- three' }).size.state, 'ok'); assert.match(assess({ outcome: '- one\n- two\n- three' }).size.words, /About 3 tasks/);
assert.equal(assess({ outcome: Array.from({ length: 16 }, (_, i) => `- step ${i}`).join('\n') }).size.state, 'warn');
assert.equal(assess({ outcome: Array.from({ length: 15 }, (_, i) => `- step ${i}`).join('\n') }).size.state, 'ok', 'fifteen is the top of the range');
// the summary counts what to look at
a = assess({ title: 'Add search plus filters', doneWhen: 'It works well' });
assert.equal(a.looks, 2); assert.equal(a.summary, '2 things to look at');
assert.equal(assess({ title: 'Customers import a CSV on their own', doneWhen: 'A customer imports a CSV in under a minute' }).summary, 'Nothing to look at');
assert.equal(TASKS_MIN, 2); assert.equal(TASKS_MAX, 15); assert.ok(EXAMPLES.length >= 2 && EXAMPLES.every(e => assess({ doneWhen: e }).checks.find(c => c.id === 'done').state === 'ok'), 'every example passes its own rule');
console.log('PASS goal_guide: one outcome, done when, size and the summary');
