// The Activity folder's filters (#12070): what a search and each filter match, the order, and that the search words are not kept.
import assert from 'node:assert/strict';
import * as AF from '../../coral-go/pkg/frontend/static/operator_activity_filters.js';

const row = (id, o) => ({ id, at: `2026-11-0${id}T10:00:00Z`, actor: 'local', action: 'approve', item_kind: 'file', item_id: 'x', team: 'alpha', title: `File ${id}`, note: '', source: 'local', ...o });
const rows = [row(1, { title: 'Plan', note: 'looks good' }), row(2, { action: 'deny', team: 'beta', note: 'Not this quarter' }), row(3, { action: 'goal_close', item_kind: 'goal', title: 'Ship it', note: 'done: shipped' })];
const ids = (f) => AF.ordered(rows.filter(r => AF.matches(r, f)), f).map(r => r.id);

assert.deepEqual(ids(AF.EMPTY), [3, 2, 1], 'newest first');
assert.deepEqual(ids({ ...AF.EMPTY, sort: 'oldest' }), [1, 2, 3], 'the other order');
assert.deepEqual(ids({ ...AF.EMPTY, q: 'quarter' }), [2], 'the search covers the note');
assert.deepEqual(ids({ ...AF.EMPTY, q: 'denied' }), [2], 'and the words of the action');
assert.deepEqual(ids({ ...AF.EMPTY, q: 'ship' }), [3], 'and the title');
assert.deepEqual(ids({ ...AF.EMPTY, team: 'beta' }), [2]);
assert.deepEqual(ids({ ...AF.EMPTY, action: 'goal_close' }), [3]);
assert.deepEqual(ids({ ...AF.EMPTY, decision: 'deny' }), [2], 'Decision groups the denial actions');
assert.equal(AF.decisionOf({action:'ignore'}),'dismiss','ignored asks are Dismissed');
assert.equal(AF.decisionOf({action:'file_star'}),'','a file star is not an approval');
assert.equal(AF.matches(row(1,{task_title:'Prepare the launch'}),{...AF.EMPTY,q:'prepare the launch'}),true,'search includes thread context');
assert.deepEqual(ids({ ...AF.EMPTY, action: 'bogus' }), [3, 2, 1], 'an action that is not one is no filter');
assert.deepEqual(ids({ ...AF.EMPTY, from: '2026-11-02' }), [3, 2], 'since a day');
assert.equal(AF.isFiltered(AF.EMPTY), false); assert.equal(AF.isFiltered({ ...AF.EMPTY, team: 'beta' }), true);
assert.equal(AF.isFiltered({ ...AF.EMPTY, sort: 'oldest' }), false, 'the order alone does not narrow');
AF.setTeamNames(new Map([['beta', 'Beta team']]));
assert.ok(AF.chips({ ...AF.EMPTY, team: 'beta' }).some(c => /Team: Beta team/.test(c.label || c.text || String(c))), 'the team chip says the name');
assert.ok(AF.ACTIONS.includes('undone') && AF.ACTIONS.includes('goal_close'));
// Kind chips are exclusive: each row has exactly one primary kind, so the sum equals the total (#16825)
const kindRows = [
    row(10, { action: 'answer', item_kind: 'question', title: 'Pick a database' }), // answers (not decisions, even though it is a decision)
    row(11, { action: 'prompt_answer', item_kind: 'agent', title: 'sudo' }), // permissions (not decisions)
    row(12, { action: 'prompt_allow', item_kind: 'agent', title: 'deploy' }), // permissions (not decisions)
    row(13, { action: 'approve', item_kind: 'file', title: 'spec.md' }), // files (not decisions: item_kind is file)
    row(14, { action: 'message', item_kind: 'agent', title: 'hello' }), // words
    row(15, { action: 'deny', item_kind: 'file', title: 'draft.md' }), // files (item_kind is file, even though deny is a decision)
    row(16, { action: 'task_complete', item_kind: 'task', title: 'build' }), // files (item_kind is task)
    row(17, { action: 'skill_approve', item_kind: 'skill', title: 'linter' }), // decisions (skill_approve is a decision, item_kind is skill — not files, answers or permissions)
    row(18, { action: 'goal_close', item_kind: 'goal', title: 'Ship v2' }), // files (item_kind is goal)
];
const kindCount = k => kindRows.filter(r => AF.inKind(r, k)).length;
const total = kindRows.length;
const chipSum = AF.KINDS.reduce((sum, k) => sum + kindCount(k), 0);
assert.equal(chipSum, total, `the kind chips add to the total (${chipSum} vs ${total}): no row in two kinds`);
assert.ok(AF.inKind(kindRows[0], 'answers'), 'an answer is in Answers');
assert.ok(!AF.inKind(kindRows[0], 'decisions'), 'an answer is NOT in Decisions (exclusive)');
assert.ok(AF.inKind(kindRows[1], 'permissions'), 'a prompt_answer is in Permissions');
assert.ok(!AF.inKind(kindRows[1], 'decisions'), 'a prompt_answer is NOT in Decisions');
assert.ok(AF.inKind(kindRows[3], 'files'), 'an approve of a file is in Files');
assert.ok(!AF.inKind(kindRows[3], 'decisions'), 'an approve of a file is NOT in Decisions');
assert.ok(AF.inKind(kindRows[4], 'words'), 'a message is in Words');
assert.ok(AF.inKind(kindRows[7], 'decisions'), 'a skill_approve is in Decisions (no more specific kind)');
// A row whose action matches no specific kind still lands in a chip, so the sum never falls short (#16983)
const noKindRows = [
    ...kindRows,
    row(19, { action: 'hub_update_check', item_kind: 'setting', title: 'Checked for update' }),
    row(20, { action: 'save', item_kind: 'agent', title: 'Saved for later' }),
    row(21, { action: 'mark_read', item_kind: 'file', title: 'spec.md' }), // mark_read of a file: item_kind is file, but the action is not a decision and files test includes file → files
    row(22, { action: 'run_seen', item_kind: 'run', title: 'Run 42' }), // run_seen: item_kind is run, not file/task/goal → no specific kind before this fix
];
const noKindCount = k => noKindRows.filter(r => AF.inKind(r, k)).length;
const noKindTotal = noKindRows.length;
const noKindChipSum = AF.KINDS.reduce((sum, k) => sum + noKindCount(k), 0);
assert.equal(noKindChipSum, noKindTotal, `every row has a primary kind (${noKindChipSum} vs ${noKindTotal}): no row outside all chips`);
assert.ok(AF.inKind(noKindRows[9], 'decisions'), 'hub_update_check is in Decisions (the fallback kind)');
assert.ok(AF.inKind(noKindRows[10], 'decisions'), 'save is in Decisions (the fallback kind)');
assert.ok(AF.inKind(noKindRows[11], 'files'), 'mark_read of a file is in Files (item_kind is file)');
assert.ok(AF.inKind(noKindRows[12], 'decisions'), 'run_seen is in Decisions (the fallback kind)');
console.log('PASS operator_activity_filters: search, team, action, since, order, exclusive kinds, no-kind fallback');
