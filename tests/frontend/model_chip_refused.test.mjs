// #13761 (the Operator: changing an agent's model from the chat box on a remote computer through the self-hosted Hub said 'only operator may change the model'): a refusal from ANOTHER computer begins with that
// computer's name, from the Hub's own server list, so the person sees which computer refused; this computer's own refusals and every other answer are as they came.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
state.servers = [{ id: 'm1', label: 'build-box', owner_stamp: true, transport: 'ssh' }, { id: 'm2', label: 'evil\nname with a very long label that goes on and on and on for ever', owner_stamp: true }, { id: 'm3', label: 'by-address', transport: 'http', owner_stamp: false }, { id: 'm4', label: 'fresh-ssh', transport: 'ssh', owner_stamp: false }, { id: 'm5', label: 'unknown-shape' }];
const { refusedWords } = await importUi('model_chip_refusal');
const refusal = { code: 'operator_only', error: 'this computer changes an agent\'s model only for a person at its own dashboard' };
const m1 = refusedWords('m1', 403, refusal);
assert.ok(m1.startsWith('build-box did not take the change:') && /signed-in person/.test(m1) && /update Coral on build-box/.test(m1) && !/Set up approvals/.test(m1), 'an SSH computer that holds the secret is told: sign in, update it; never set up approvals: ' + m1);
const m4 = refusedWords('m4', 403, refusal);
assert.ok(/approvals are not set up/.test(m4) && /press Set up approvals for fresh-ssh/.test(m4), 'an SSH computer with no working approvals: ' + m4);
const m3 = refusedWords('m3', 403, refusal);
assert.ok(/press Approve through this hub for by-address/.test(m3) && !/Set up approvals/.test(m3), 'a computer added by address gets the secret step: ' + m3);
assert.equal(refusedWords('m5', 403, refusal), "unknown-shape did not take the change: " + refusal.error, 'a computer whose shape the list does not say gets the computer\'s own words');
assert.equal(refusedWords('local', 403, refusal), refusal.error, "this computer's own refusal is as it came");
assert.equal(refusedWords('', 403, refusal), refusal.error);
assert.equal(refusedWords('m1', 400, { code: 'x', error: 'bad model' }), 'bad model', 'only the person gate gets the computer\'s name');
assert.equal(refusedWords('m1', 403, { code: 'other', error: 'no' }), 'no');
assert.equal(refusedWords('m1', 500, undefined), 'The change was not made.');
const long = refusedWords('m2', 403, refusal);
assert.ok(!/[\n\r]/.test(long) && long.indexOf(' did not take') <= 41, 'a long or control-laden label is cleaned and cut: ' + long);
assert.equal(refusedWords('unknown-id', 403, refusal).startsWith('unknown-id did not take'), true, 'a computer not in the list is named by its id');
console.log('model_chip_refused: a refusal from another computer names it');
