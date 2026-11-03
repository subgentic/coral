// #12533 (new-user walk #12526): a team's Agents list said "Idle" (and, on a phone, "No messages yet") while the agent's own page said "Starting Claude..." and a team message had not reached it. The state word every list surface reads
// (sessionStateInfo: row aria-label, status line, header) says Starting while the live list says the CLI has not emitted its first event (row.starting, #6381); an agent that has started, is asleep, or is a terminal keeps its own word.
//   node agent_list_starting.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const m = await importUi('session_state');
const word = (row) => m.sessionStateInfo({ session_id: 's', agent_type: 'claude', ...row }).label;
assert.equal(word({ starting: true }), 'Starting', 'a CLI that has not written its first event is Starting, not Idle');
assert.equal(word({}), 'Idle', 'a started agent with nothing to do is Idle');
assert.equal(word({ starting: false }), 'Idle');
assert.equal(word({ starting: true, working: true }), 'Working', 'a working agent is working');
assert.equal(word({ starting: true, sleeping: true }), 'Sleeping', 'asleep says asleep');
assert.equal(word({ starting: true, agent_type: 'terminal' }), 'Idle', 'a terminal does not start a CLI');
assert.equal(word({ starting: true, waiting_for_input: true }), 'Needs input', 'a question wins');
assert.equal(word({ starting: true, stuck: true }), 'Stuck');
console.log('agent_list_starting: ok');
