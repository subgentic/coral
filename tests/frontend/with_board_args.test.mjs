// withBoard (#19574, QA4): a team-menu button passes its board and nothing else; only a button that names a session (the agent menu's Distill knowledge) passes it as a second argument. A null second argument
// would reach showTeamAvailabilityWorkspace(team, options = {}) as options and throw (a default parameter applies to undefined only).
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { withBoard } = await importUi('action_helpers');
const calls = [];
window.fn = (...a) => calls.push(a); window.closeSidebarKebabs = () => {};
const press = data => { const el = document.createElement('button'); Object.assign(el.dataset, data); withBoard('fn')(el, { stopPropagation() {} }); };
press({ board: 'team-a' });
press({ board: 'team-a', sessionId: 'sid-1' });
press({ board: 'team-a', sessionId: 'bad id<script>' });
assert.deepEqual(calls[0], ['team-a'], 'no session: one argument, as before');
assert.deepEqual(calls[1], ['team-a', 'sid-1'], 'a session id is the second argument');
assert.deepEqual(calls[2], ['team-a'], 'a session id that is not a token is not passed');
console.log('PASS withBoard: the board alone, plus the session id only when one is named and valid');
