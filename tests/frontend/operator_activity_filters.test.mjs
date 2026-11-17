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
// #17360: the person's comment on a file, an agent's reply and an agent's new version are rows under Files and tasks (the chips overlap by design, #16116).
for (const action of ['file_comment', 'file_reply', 'file_version']) assert.ok(AF.inKind({ action, item_kind: 'file' }, 'files'), action + ' is a Files and tasks row');

// #19149: the Important view. A browser that kept nothing opens on it; it hides delivery bookkeeping ('Sent held words to') and shows what a person did or must act on; Everything shows all; a kept choice wins.
{
    const held = row(4, { action: 'wait_send', item_kind: 'agent', title: 'site-designer-agy' }), asked = row(5, { action: 'answer', item_kind: 'question' }), dismissed = row(6, { action: 'ignore' });
    const all = [held, asked, dismissed], on = { ...AF.EMPTY, important: true }, every = { ...AF.EMPTY, important: false };
    const idsOf = f => all.filter(r => AF.matches(r, f)).map(r => r.id);
    assert.deepEqual(idsOf(on), [5, 6], "Important hides 'Sent held words to' and keeps an answer and a dismissal");
    assert.deepEqual(idsOf(every), [4, 5, 6], 'Everything shows every row');
    assert.deepEqual(idsOf(AF.EMPTY), [4, 5, 6], 'the empty filters are Everything: Clear all lands there');
    assert.equal(AF.isNoise(held), true); assert.equal(AF.isNoise(asked), false);
    for (const a of ['approve', 'deny', 'answer', 'ignore', 'dismiss', 'prompt_answer', 'goal_review', 'skill_approve', 'message', 'task_reply', 'file_review', 'proposal']) assert.equal(AF.isNoise({ action: a }), false, a + ' is kept');
    assert.deepEqual(all.filter(r => AF.passesImportant(r, on)).map(r => r.id), idsOf(on), 'the count rule is the list rule');
    assert.equal(AF.clean({ important: 'yes' }).important, false, 'only a literal true is on');
    // #19219: the default Important view is not a filter the person set, and Clear all lands on Everything
    assert.equal(AF.isFiltered(on), false, 'Important alone is not a filter'); assert.equal(AF.isFiltered(every), false);
    assert.equal(AF.isQuery(on), false, 'and it is not kept as a query');
    assert.deepEqual(AF.chips(on), [], 'no chip repeats the view'); assert.deepEqual(AF.chips(every), []);
    assert.equal(AF.clean({ ...on, team: 'beta' }).important, true); assert.equal(AF.EMPTY.important, false, 'the empty filters (what Clear all applies) are Everything');
    assert.equal(AF.isFiltered({ ...on, team: 'beta' }), true, 'another filter still counts');
    // the default and the kept choice
    assert.equal(AF.loadFilters().important, true, 'a browser that kept nothing opens on Important');
    AF.saveFilters(every);
    assert.equal(AF.loadFilters().important, false, 'a kept Everything is not turned back into Important');
    AF.saveFilters(on);
    assert.equal(AF.loadFilters().important, true);
    const store = (await import('../../coral-go/pkg/frontend/static/safe_storage.js')).browserLocal;
    store.set(AF.storageKey('inbox-activity'), JSON.stringify({ sort: 'oldest' }));
    assert.equal(AF.loadFilters().important, true, 'a record kept before Important was added opens on Important (one time)');
    assert.equal(AF.loadFilters().sort, 'oldest', 'and keeps the rest of what it kept');
    AF.saveFilters({ ...AF.loadFilters(), important: false });
    assert.equal(AF.loadFilters().important, false, 'Everything picked after this change is kept');
    store.remove(AF.storageKey('inbox-activity'));
    assert.equal(AF.loadFilters().important, true);
}
console.log('PASS operator_activity_filters: search, team, action, since, order');
