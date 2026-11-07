// codex_mode.js (#14051): the words for a Codex agent's live mode: the chip beside it, the question before a Wake that would start it narrower, the note in the Restart form. Pure functions of the
// list row's codex_live_mode and codex_relaunch_narrows (the server's, from the agent's rollout: display only).
//   node codex_mode.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

process.env.CORAL_TELEMETRY_DISABLED = '1'; // a jsdom page: no Coral starts; the opt-out stays on for the telemetry census

installDom({ mode: 'local' });
const m = await importUi('codex_mode');

const narrows = { live: 'Full access', launch: 'Workspace write, asks when needed' };
assert.equal(m.relaunchNarrowing(null), null);
assert.equal(m.relaunchNarrowing({}), null);
assert.equal(m.relaunchNarrowing({ codex_relaunch_narrows: null }), null);
assert.equal(m.relaunchNarrowing({ codex_relaunch_narrows: { live: 'Full access' } }), null, 'half an answer says nothing');
assert.deepEqual(m.relaunchNarrowing({ codex_relaunch_narrows: narrows }), narrows);
assert.equal(m.relaunchNarrowing({ codex_relaunch_narrows: { live: 3, launch: {} } }), null, 'only words');

assert.equal(m.wakeQuestion('Dev One', narrows),
    'Wake Dev One? It ran with Full access. Waking starts Codex again with Workspace write, asks when needed, the settings it was launched with: a mode set inside Codex is not kept.');
assert.equal(m.restartHint(narrows),
    'Running with Full access now; restarting starts Codex with Workspace write, asks when needed. A mode set inside Codex is not kept.');

assert.equal(m.modeChip(null), null);
assert.equal(m.modeChip({ agent_type: 'claude' }), null, 'only a Codex row has a mode');
assert.equal(m.modeChip({ agent_type: 'codex', codex_live_mode: null }), null, 'no turn_context yet: no mode is invented');
assert.equal(m.modeChip({ agent_type: 'codex', codex_live_mode: { label: '' } }), null);
const chip = m.modeChip({ agent_type: 'codex', codex_live_mode: { approval: 'never', sandbox: 'danger-full-access', label: 'Full access' } });
assert.equal(chip.text, 'Full access');
assert.match(chip.title, /agent.s newest turn/); assert.match(chip.title, /approval never, sandbox danger-full-access/); assert.match(chip.title, /display only|Shown only/i);
assert.equal(m.modeChip({ agent_type: 'codex', codex_live_mode: { label: 'Workspace write, asks when needed' } }).warn, false, 'a chip itself is not a warning');
assert.equal(m.modeChip({ agent_type: 'codex', codex_live_mode: { label: 'Full access' }, codex_relaunch_narrows: narrows }).warn, true, 'a relaunch would narrow it: the chip says so');
assert.match(m.modeChip({ agent_type: 'codex', codex_live_mode: { label: 'Full access' }, codex_relaunch_narrows: narrows }).title, /Workspace write, asks when needed/);
console.log('PASS codex_mode');
