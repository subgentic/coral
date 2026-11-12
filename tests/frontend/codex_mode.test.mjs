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
    'Running with Full access now; restarting starts Codex with Workspace write, asks when needed, unless you change the permission mode or flags below. A mode set inside Codex is not kept.');

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

// "Keep Full access when this agent restarts" (#14061)
assert.equal(m.keepChip(null), null);
assert.equal(m.keepChip({ agent_type: 'codex' }), null, 'no key: not shown (an agent or a Hub viewer never gets it)');
assert.equal(m.keepChip({ agent_type: 'codex', keep_full_access: false }), null);
assert.equal(m.keepChip({ agent_type: 'terminal', keep_full_access: true }), null, 'only the three CLIs');
assert.equal(m.keepChip({ agent_type: 'claude', keep_full_access: true }).button.mode, 'off', 'Claude has it too (#14085)');
assert.equal(m.keepChip({ agent_type: 'codex', keep_full_access: true }).text, 'Full access kept on restart');
assert.match(m.keepChip({ agent_type: 'codex', keep_full_access: true }).title, /capabilities/);
assert.deepEqual(m.keepMenuItem({ keep_full_access: true }), { label: 'Stop keeping Full access on restart', mode: 'off' });
assert.deepEqual(m.keepMenuItem({ keep_full_access: false }), { label: 'Keep Full access on restart', mode: 'on' });
assert.deepEqual(m.keepMenuItem(null), { label: 'Keep Full access on restart', mode: 'on' });

// What the capabilities do to the chosen mode (#14085): the Operator's report, an agy Technical Writer launched with Bypass that ran in accept-edits
const narrowedRow = { agent_type: 'agy', keep_full_access: false, permission_effective: { chosen: 'Bypass permissions', effective: 'Accept edits', narrowed: true, why: 'the capabilities this agent was given allow less than the mode that was chosen' } };
assert.deepEqual(m.permissionNarrowing(narrowedRow), { chosen: 'Bypass permissions', effective: 'Accept edits', why: 'the capabilities this agent was given allow less than the mode that was chosen' });
assert.equal(m.permissionNarrowing({ ...narrowedRow, keep_full_access: true }), null, 'the Operator chose Full access: nothing narrowed');
assert.equal(m.permissionNarrowing({ ...narrowedRow, permission_effective: { ...narrowedRow.permission_effective, narrowed: false } }), null);
assert.equal(m.permissionNarrowing({ agent_type: 'claude', keep_full_access: false, permission_effective: null }), null);
assert.equal(m.permissionNarrowing({ ...narrowedRow, permission_effective: { chosen: 'Bypass permissions', narrowed: true } }), null, 'half an answer says nothing');
const nchip = m.keepChip(narrowedRow);
assert.equal(nchip.text, 'Runs with Accept edits, not Bypass permissions'); assert.equal(nchip.button.mode, 'use'); assert.equal(nchip.button.label, 'Use Full access'); assert.equal(nchip.warn, true);
assert.deepEqual(m.keepMenuItem(narrowedRow), { label: 'Use Full access for this agent', mode: 'use' });
const ni = m.keepInfo(narrowedRow);
assert.equal(ni.on, false); assert.match(ni.text, /^Runs with Accept edits, not the Bypass permissions that was chosen/); assert.equal(ni.button.mode, 'use');
assert.equal(m.keepInfo({ agent_type: 'agy', keep_full_access: true }).button.label, 'Turn off');
assert.equal(m.keepInfo({ agent_type: 'agy', keep_full_access: false }).button, null, 'nothing narrowed, not kept: no button');
const nn = m.permissionNarrowing(narrowedRow), base = 'Use Full access for Technical Writer? It was started with Bypass permissions chosen, but the capabilities this agent was given allow less than the mode that was chosen, so it runs with Accept edits. Coral restarts it now with Full access and starts it that way every time it restarts, whatever its role\'s capabilities say.';
assert.equal(m.useFullAccessQuestion('Technical Writer', nn, 'agy'), base + ' It also lifts the limits this role\'s capabilities set on what it may do.');
assert.equal(m.useFullAccessQuestion('Technical Writer', nn, 'claude'), base + " It also lifts the commands this role is blocked from (Claude's deny rules).");
assert.equal(m.useFullAccessQuestion('Technical Writer', nn, 'codex'), base + ' It also lifts the limits this role\'s capabilities set on what it may touch (its sandbox and approval rules).');
assert.equal(m.keepResetNote(0), ''); assert.equal(m.keepResetNote(1), ' 1 agent keeps Full access.'); assert.equal(m.keepResetNote(3), ' 3 agents keep Full access.');
// agy says what it was started with (no mode of its own to read back)
const agyChip = m.modeChip(narrowedRow);
assert.equal(agyChip.key, 'Started with: '); assert.equal(agyChip.text, 'Accept edits'); assert.equal(agyChip.warn, true); assert.match(agyChip.title, /agy does not tell Coral/);
assert.equal(m.modeChip({ agent_type: 'agy', permission_effective: null }), null);
assert.equal(m.modeChip({ agent_type: 'agy', keep_full_access: true, permission_effective: { chosen: 'Bypass permissions', effective: 'Bypass permissions', narrowed: false } }).warn, false);
assert.equal(m.modeChip({ agent_type: 'codex', codex_live_mode: { label: 'Full access' } }).key, 'Mode: ');
assert.equal(m.keepInfo(null), null);
assert.equal(m.keepInfo({ agent_type: 'codex' }), null, 'no key: nothing (an agent or a Hub viewer never gets it)');
assert.equal(m.keepInfo({ agent_type: 'terminal', keep_full_access: true }), null, 'only the three CLIs');
assert.equal(m.keepInfo({ agent_type: 'codex', keep_full_access: true }).on, true);
assert.match(m.keepInfo({ agent_type: 'codex', keep_full_access: true }).text, /^Kept: every restart/);
assert.equal(m.keepInfo({ agent_type: 'codex', keep_full_access: false }).on, false);
assert.match(m.keepInfo({ agent_type: 'codex', keep_full_access: false }).text, /^Not kept/);
// A change answered for one computer never touches the same session id on another (UI Reviewer, #14061)
assert.equal(m.keepEventMatches({ sessionId: 'sid-1', on: false, server: 'm1' }, 'sid-1', 'm1'), true);
assert.equal(m.keepEventMatches({ sessionId: 'sid-1', on: false, server: 'm1' }, 'sid-1', 'm2'), false, 'the same id on another computer');
assert.equal(m.keepEventMatches({ sessionId: 'sid-1', on: false, server: 'm1' }, 'sid-2', 'm1'), false);
assert.equal(m.keepEventMatches({ sessionId: 'sid-1', on: false }, 'sid-1', 'm1'), false, 'no computer in the event: not matched');
assert.equal(m.keepEventMatches({ sessionId: '', server: '' }, '', ''), false);
assert.equal(m.keepEventMatches(null, 'sid-1', 'm1'), false);
console.log('PASS codex_mode');

// #15735: with Keep Full access in force the chip says Full access, not the stored mode, with or without a live read, for Codex and agy; a Claude row has no such chip; off, the live read stands.
const kept = m.modeChip({ agent_type: 'codex', keep_full_access: true, permission_mode: 'plan', codex_live_mode: { approval: 'on-request', sandbox: 'read-only', label: 'Plan' } });
assert.equal(kept.text, 'Full access'); assert.equal(kept.key, 'Mode: '); assert.equal(kept.warn, false); assert.match(kept.title, /whatever its stored mode \(plan\)/);
assert.equal(m.modeChip({ agent_type: 'codex', keep_full_access: true }).text, 'Full access', 'before any turn has been read');
assert.equal(m.modeChip({ agent_type: 'agy', keep_full_access: true, permission_effective: { effective: 'plan' } }).text, 'Full access');
assert.equal(m.modeChip({ agent_type: 'claude', keep_full_access: true }), null);
assert.equal(m.modeChip({ agent_type: 'codex', keep_full_access: false, codex_live_mode: { label: 'Plan' } }).text, 'Plan', 'off: the live read stands');
