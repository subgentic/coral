// The three approval presets are names for the team's existing flags, never a stored setting (#11657, #11589's design): which name the flags match, which flags a name sets, and that Fully autonomous leaves require_goal alone.
import assert from 'node:assert/strict';
import { APPROVAL_PRESETS, NEW_TEAM_APPROVAL, presetOf, presetFlags, approvalField } from '../../coral-go/pkg/frontend/static/team_approval_presets.js';

assert.deepEqual(APPROVAL_PRESETS.map(p => p.label), ['Operator approves tasks', 'Operator approves goals', 'Fully autonomous'], 'the Operator\'s three words, in order');
assert.equal(NEW_TEAM_APPROVAL, 'goals', 'a new team starts on Operator approves goals');

// flags -> name
assert.equal(presetOf({ goals_need_approval: true, tasks_need_approval: true, require_goal: true }), 'tasks');
assert.equal(presetOf({ goals_need_approval: true, tasks_need_approval: false, require_goal: true }), 'goals');
assert.equal(presetOf({ goals_need_approval: false, tasks_need_approval: false, require_goal: false }), 'auto', 'today\'s default is Fully autonomous');
assert.equal(presetOf({ goals_need_approval: false, tasks_need_approval: false, require_goal: true }), 'auto', 'Fully autonomous does not care about Require a goal');
assert.equal(presetOf({}), 'auto');
assert.equal(presetOf({ goals_need_approval: true, tasks_need_approval: false, require_goal: false }), 'custom', 'goal approval without Require a goal lets tasks past the gate: Custom');
assert.equal(presetOf({ goals_need_approval: true, tasks_need_approval: true, require_goal: false }), 'custom');
assert.equal(presetOf({ goals_need_approval: false, tasks_need_approval: true, require_goal: true }), 'custom', 'task approval alone is none of the three');
assert.equal(presetOf(null), 'auto');

// name -> flags
assert.deepEqual(presetFlags('tasks'), { goals_need_approval: true, tasks_need_approval: true, require_goal: true });
assert.deepEqual(presetFlags('goals'), { goals_need_approval: true, tasks_need_approval: false, require_goal: true }, 'goals sets require_goal on');
assert.deepEqual(presetFlags('auto'), { goals_need_approval: false, tasks_need_approval: false }, 'Fully autonomous leaves Require a goal as it is');
assert.equal(presetFlags('custom'), null, 'Custom sets nothing');
assert.equal(presetFlags('nope'), null);
for (const p of APPROVAL_PRESETS) assert.equal(presetOf({ goals_need_approval: p.goals, tasks_need_approval: p.tasks, require_goal: !!p.requireGoal }), p.id, `${p.id}: its own flags read back as it`);

// the row: three choices, plus Custom where the flags can differ; the words say what it is not
assert.deepEqual(approvalField().options.map(o => o.value), ['tasks', 'goals', 'auto', 'custom']);
assert.deepEqual(approvalField({ custom: false }).options.map(o => o.value), ['tasks', 'goals', 'auto'], 'a new team has no Custom');
assert.match(APPROVAL_PRESETS.find(p => p.id === 'auto').help, /planning only/, 'Fully autonomous says it is planning only');
assert.match(APPROVAL_PRESETS.find(p => p.id === 'auto').help, /for review/, 'and that a file for review still reaches Needs you');
console.log('team_approval_presets: ok');
