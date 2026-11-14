// #16635 (walk 27 F17/F18): three fixes to the Goals folder in the Inbox.
// 1. goal_columns.js: a goal with all tasks done says "All N done", not "N done" (the operator sees the goal is finished).
// 2. inbox_sidebar.js: when all goals are done the empty state says "All goals are done.", not "No open goals." (the Done tab's text is "No finished goals.").
// 3. goal_closed_items.js: a "Goal closed as done by <agent>" notice has no waiting_since, so the Waiting column does not say "waiting 1 min".
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const waitForText = async (sel, expected, label, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const text = document.querySelector(sel)?.textContent || null;
        if (text === expected) return;
        await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(document.querySelector(sel)?.textContent || null, expected, label);
};

// --- Bug 3: closed-goal notice items have no waiting_since ---
installDom({ mode: 'local' });
const GCI = await importUi('goal_closed_items');

const now = Date.parse('2026-11-13T12:00:00Z');
const closedGoal = (id, by, at) => ({ id, state: 'done', closed_by: by, closed_at: new Date(at).toISOString(), closed_reason: 'All tasks finished', title: `Goal ${id}` });
const teamOf = () => 'team-a';
const noop = () => {};

// a goal an agent closed: it is a row, and waiting_since is empty
const agentClosed = closedGoal(1, 'orch', now - 60000);
const rows = GCI.closedGoalRows([agentClosed], teamOf, { reopen: noop, now });
assert.equal(rows.length, 1, 'the agent-closed goal produces a row');
assert.equal(rows[0].waiting_since, '', 'waiting_since is empty: no "waiting 1 min" on an informational notice');
assert.ok(rows[0].waiting_kind === 'welcome', 'it is a welcome item (listed, not counted)');
assert.ok(rows[0].display_name.includes('Goal #1 closed as done by orch'), 'the title names the goal and agent');

// a goal the Operator closed: no row
const opClosed = closedGoal(2, 'Operator', now - 60000);
assert.equal(GCI.closedGoalRows([opClosed], teamOf, { reopen: noop, now }).length, 0, 'the Operator\'s own close has no row');

// --- Bug 1: "All N done" rendered by goalColumns ---
const GC = await importUi('goal_columns');
const goalCol = GC.goalColumns().find(c => c.key === 'goal');

// a goal with all 3 tasks done: the tasks span says "All 3 done"
const cell3 = goalCol.cell({ id: 1, title: 'Ship it', rollup: { done: 3 } });
const tasks3 = cell3.querySelector('.goals-row-tasks');
assert.equal(tasks3.textContent, 'All 3 done', 'a goal with 3/3 done says "All 3 done": ' + tasks3.textContent);

// a goal with 1 task done: the tasks span says "1 done", not "All 1 done"
const cell1 = goalCol.cell({ id: 2, title: 'Solo task', rollup: { done: 1 } });
const tasks1 = cell1.querySelector('.goals-row-tasks');
assert.equal(tasks1.textContent, '1 done', '"1 done" for one task, not "All 1 done": ' + tasks1.textContent);

// a goal with some open tasks: the tasks span says "2 done · 1 left"
const cellMix = goalCol.cell({ id: 3, title: 'In progress', rollup: { done: 2, active: 1 } });
const tasksMix = cellMix.querySelector('.goals-row-tasks');
assert.equal(tasksMix.textContent, '2 done · 1 left', 'a partial goal says "2 done · 1 left": ' + tasksMix.textContent);

// --- Bug 2: empty-state text rendered in the Goals folder ---
let goalsReply = [];
globalThis.fetch = window.fetch = async (url) => {
    const p = String(url).replace(/\?.*/, '').replace(/^https?:\/\/[^/]+/, '');
    if (p === '/api/goals') return Response.json({ goals: goalsReply });
    if (p === '/api/settings') return Response.json({ settings: {} });
    return Response.json({});
};
const { state } = await importUi('state');
state.hub = false;
document.body.setAttribute('data-nav-tab', 'hub-inbox');
const IS = await importUi('inbox_sidebar');

// no goals at all: "No open goals."
goalsReply = [];
await IS.showInbox({ folder: 'goals' });
await waitForText('.empty-state-line', 'No open goals.', 'the empty Goals folder says "No open goals." when there are none');

// only done goals (the default All view excludes them, so the table is empty): "All goals are done."
goalsReply = [{ id: 1, board_id: 'team-a', title: 'Ship v2', state: 'done', rollup: { done: 2 }, updated_at: new Date().toISOString() }];
await IS.showInbox({ folder: 'goals' });
await waitForText('.empty-state-line', 'All goals are done.', 'the empty Goals folder says "All goals are done." when done goals exist');

console.log('PASS goal_inbox_fixes: closed-goal notice has no waiting text, columns say All N done, empty state names the done goals');
