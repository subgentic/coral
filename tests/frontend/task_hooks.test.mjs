// #3837/#19056: subagents redraw the registered task list; dialog closing no longer depends on this hook.
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const hooks = await importUi('task_hooks');
assert.doesNotThrow(() => hooks.redrawBoardTaskList(), 'before registration redraw does nothing');
const calls = [];
hooks.registerTaskView({ renderBoardTaskList: () => calls.push('render') });
hooks.redrawBoardTaskList();
assert.deepEqual(calls, ['render'], 'redraw calls what tasks.js registered');
const later = [];
hooks.registerTaskView({ renderBoardTaskList: () => later.push('render2') });
hooks.redrawBoardTaskList();
assert.deepEqual(later, ['render2'], 'a new registration replaces the old');
assert.equal(calls.length, 1, 'the old view is not called again');
hooks.registerTaskView(null);
assert.doesNotThrow(() => hooks.redrawBoardTaskList(), 'a removed view does nothing');
console.log('task_hooks: ok');
