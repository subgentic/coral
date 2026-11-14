// #16635 (walk 27 F17/F18): three fixes to the Goals folder in the Inbox.
// 1. goal_columns.js: a goal with all tasks done says "All N done", not "N done" (the operator sees the goal is finished).
// 2. inbox_sidebar.js: when all goals are done the empty state says "All goals are done.", not "No open goals." (the Done tab's text is "No finished goals.").
// 3. goal_closed_items.js: a "Goal closed as done by <agent>" notice has no waiting_since, so the Waiting column does not say "waiting 1 min".
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = name => fs.readFileSync(path.resolve(here, '../../coral-go/pkg/frontend/static', name + '.js'), 'utf8');

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
assert.ok(rows[0].waiting_kind === 'goal_done', 'it is a goal_done item (the Goal looks done pill)');
assert.ok(rows[0].display_name.includes('Goal #1 closed as done by orch'), 'the title names the goal and agent');

// a goal the Operator closed: no row
const opClosed = closedGoal(2, 'Operator', now - 60000);
assert.equal(GCI.closedGoalRows([opClosed], teamOf, { reopen: noop, now }).length, 0, 'the Operator\'s own close has no row');

// --- Bug 1: "All N done" in goal_columns.js ---
const colSrc = source('goal_columns');
assert.match(colSrc, /All \$\{n\} done/, 'the task count says "All N done" when every task is done');
assert.match(colSrc, /n > 1 \? `All/, 'the plural guard: "All 2 done" for 2+, "1 done" for 1');

// --- Bug 2: "All goals are done." in inbox_sidebar.js ---
const sidebarSrc = source('inbox_sidebar');
assert.match(sidebarSrc, /All goals are done/, 'the empty state says "All goals are done." when done goals exist');
assert.match(sidebarSrc, /No finished goals/, 'the Done tab\'s empty state says "No finished goals."');
assert.match(sidebarSrc, /No open goals/, '"No open goals." is still the text when there are no goals at all');

console.log('PASS goal_inbox_fixes: closed-goal notice has no waiting text, columns say All N done, empty state names the done goals');
