// The "before starting" notice names the members whose mode is their own (#16500, Beta tester on #16387): a team whose QA Engineer is in the custom mode "Edits ok" must not read "agents default to auto mode" alone.
import assert from 'node:assert/strict';
import { launchModeNotice } from '../../coral-go/pkg/frontend/static/launch_disclosure_modes.js';
const nameOf = v => v === 'default' ? 'Default' : ({ 'custom:a1': 'Edits ok', 'custom:b2': 'Read only' })[v] || 'its own mode';
const AUTO = 'Agents launch in auto mode';

assert.deepEqual(launchModeNotice({ agents: [{ name: 'Orchestrator' }, { name: 'QA Engineer' }] }, nameOf), { title: AUTO, note: '' }, 'every member in the default: the notice is as it was');
assert.deepEqual(launchModeNotice(null, nameOf), { title: AUTO, note: '' }, 'no payload: as it was');
assert.deepEqual(launchModeNotice({}, nameOf), { title: AUTO, note: '' });
assert.deepEqual(launchModeNotice({ agents: [{ name: 'Orchestrator' }, { name: 'QA Engineer', permission_mode: 'custom:a1' }, { name: 'Dev' }] }, nameOf),
    { title: 'Most agents launch in auto mode', note: 'Not in auto mode: QA Engineer (Edits ok).' }, 'one member with its own custom mode is named');
assert.deepEqual(launchModeNotice({ agents: [{ name: 'Orchestrator' }, { name: 'QA Engineer', permission_mode: 'custom:a1' }, { name: 'Dev', permission_mode: 'default' }] }, nameOf),
    { title: 'Most agents launch in auto mode', note: 'Not in auto mode: QA Engineer (Edits ok), Dev (Default).' }, 'two members, a custom mode and Default, are both named');
assert.deepEqual(launchModeNotice({ agents: [{ name: 'A', permission_mode: 'custom:a1' }, { name: 'B', permission_mode: 'custom:b2' }] }, nameOf),
    { title: 'Agents launch in the modes you chose', note: 'Modes: A (Edits ok), B (Read only).' }, 'when every member has its own mode, none "defaults to auto"');
assert.deepEqual(launchModeNotice({ permission_mode: 'custom:a1' }, nameOf),
    { title: 'This agent does not launch in auto mode', note: 'It starts in Edits ok.' }, 'one agent in a custom mode');
assert.equal(launchModeNotice({ agents: [{ permission_mode: 'custom:a1' }, {}] }, nameOf).note, 'Not in auto mode: An agent (Edits ok).', 'a member without a name still reads');
console.log('launch_disclosure_modes: ok');
