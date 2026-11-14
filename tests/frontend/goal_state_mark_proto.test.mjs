// #15946 kept through the #16422 merge: a Hub-supplied goal state of 'constructor' or '__proto__' is an unknown state (idle), not a function on the prototype;
// the phone Goals list's goalStateMark and the State column both draw it without throwing.
//   node goal_state_mark_proto.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const { goalStateMark, goalColumns } = await importUi('goal_columns');
const stateCell = goalColumns({}, ['state'])[0].cell;
for (const state of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const g = { id: 1, title: 'g', state, rollup: {} };
    assert.doesNotThrow(() => goalStateMark(g), `goalStateMark(${state})`);
    assert.doesNotThrow(() => stateCell(g), `State column cell (${state})`);
}
console.log('goal_state_mark_proto: ok');
