// #13761 (the Operator: changing an agent's model from the chat box on a remote computer through the self-hosted Hub said 'only operator may change the model'): a refusal from ANOTHER computer begins with that
// computer's name, from the Hub's own server list, so the person sees which computer refused; this computer's own refusals and every other answer are as they came.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
state.servers = [{ id: 'm1', label: 'build-box', owner_stamp: true }, { id: 'm2', label: 'evil\nname with a very long label that goes on and on and on for ever', owner_stamp: true }];
const { refusedWords } = await importUi('model_chip');
const refusal = { code: 'operator_only', error: 'this computer changes an agent\'s model only for a person at its own dashboard' };
assert.equal(refusedWords('m1', 403, refusal), "build-box did not take the change: this computer changes an agent's model only for a person at its own dashboard");
assert.equal(refusedWords('local', 403, refusal), refusal.error, "this computer's own refusal is as it came");
assert.equal(refusedWords('', 403, refusal), refusal.error);
assert.equal(refusedWords('m1', 400, { code: 'x', error: 'bad model' }), 'bad model', 'only the person gate gets the computer\'s name');
assert.equal(refusedWords('m1', 403, { code: 'other', error: 'no' }), 'no');
assert.equal(refusedWords('m1', 500, undefined), 'The change was not made.');
const long = refusedWords('m2', 403, refusal);
assert.ok(!/[\n\r]/.test(long) && long.indexOf(' did not take') <= 41, 'a long or control-laden label is cleaned and cut: ' + long);
assert.equal(refusedWords('unknown-id', 403, refusal).startsWith('unknown-id did not take'), true, 'a computer not in the list is named by its id');
console.log('model_chip_refused: a refusal from another computer names it');
