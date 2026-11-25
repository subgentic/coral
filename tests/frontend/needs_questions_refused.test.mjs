// #15749: a remote computer's questions showed a bare "could not be read" in the Hub's Needs you. A computer that answers 401/403 refused the read: the note names it and the code it gave. #21241: it never
// blames an older Coral for a refusal (2.1.12 computers refusing a self-hosted hub's unsigned read with operator_only were): operator_only names the fix, the Approve through the hub setup; only a
// version answer (409) says to update. A failure that is not a refusal keeps the plain
// sentence, and this computer's own gap names no computer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const N = await importUi('needs_incomplete'), asks = await importUi('operator_asks'), { state } = await importUi('state');

test('a refused read of a remote names it and its code, and blames no older Coral', async () => {
    const settle = async () => { N.incompleteNote(); await new Promise(r => setTimeout(r, 30)); N.incompleteNote(); await new Promise(r => setTimeout(r, 30)); }; // the words load, then the code is read
    N.readOutcome('questions', 'srv1', false, Response.json({ code: 'operator_only' }, { status: 403 }));
    await settle();
    assert.equal(N.incompleteNote(), 'Not everything is shown: questions from srv1 could not be read. Refused by srv1 (operator_only). Set up Approve through the hub for srv1: in Settings > Computers, open it and press Approve through this hub (Set up approvals for a computer added over SSH).');
    N.readOutcome('questions', 'srv1', false, Response.json({ code: 'not a code; <b>' }, { status: 403 })); await settle();
    assert.equal(N.incompleteNote(), 'Not everything is shown: questions from srv1 could not be read. Refused by srv1.', 'a code that is not a code is not shown');
    N.readOutcome('questions', 'srv1', true);
    assert.equal(N.incompleteNote(), '', 'a good read clears it');
});
test('a read that failed, or a gap on this computer, has no refusal words', () => {
    N.readOutcome('questions', 'srv2', false);
    assert.equal(N.incompleteNote(), 'Not everything is shown: questions from srv2 could not be read.');
    N.readOutcome('questions', 'srv2', true);
    N.readOutcome('questions', 'local', false, true);
    assert.equal(N.incompleteNote(), 'Not everything is shown: questions could not be read.');
    N.readOutcome('questions', 'local', true);
});
test('the question list through the Hub reports a 403 from a remote as a refusal', async () => {
    state.hub = true; state.servers = [{ id: 'srv9', label: 'Box', status: 'online' }];
    globalThis.fetch = window.fetch = async () => Response.json({ error: 'owner_only', code: 'owner_only' }, { status: 403 });
    await asks.refreshOperatorAsks(true);
    for (let i = 0; i < 2; i++) { N.incompleteNote(); await new Promise(r => setTimeout(r, 30)); }
    assert.match(N.incompleteNote(), /Refused by Box \(owner_only\)\./, N.incompleteNote()); // by its label (#21260)
    assert.doesNotMatch(N.incompleteNote(), /Set up Approve/, 'only operator_only is the missing setup');
    assert.doesNotMatch(N.incompleteNote(), /older Coral/);
});
test('#21260: on a hub the refused note names a computer by its label in Settings > Computers, not its server id', async () => {
    state.hub = true; state.servers = [{ id: 'b-6xcc9', label: 'Build box', status: 'online' }, { id: 'odd', label: 'Odd\u202e box', status: 'online' }];
    const settle = async () => { for (let i = 0; i < 2; i++) { N.incompleteNote(); await new Promise(r => setTimeout(r, 30)); } };
    N.readOutcome('questions', 'srv9', true);
    N.readOutcome('questions', 'b-6xcc9', false, Response.json({ code: 'operator_only' }, { status: 403 }));
    await settle();
    assert.match(N.incompleteNote(), /Refused by Build box \(operator_only\)\. Set up Approve through the hub for Build box: in Settings > Computers/, N.incompleteNote());
    assert.doesNotMatch(N.incompleteNote(), /Refused by b-6xcc9/);
    N.readOutcome('questions', 'b-6xcc9', true);
    N.readOutcome('questions', 'odd', false, Response.json({ code: 'owner_only' }, { status: 403 }));
    await settle();
    assert.match(N.incompleteNote(), /Refused by Odd box \(owner_only\)\./, 'a label is cleaned like an id');
    N.readOutcome('questions', 'odd', true);
    N.readOutcome('questions', 'gone', false, Response.json({ code: 'owner_only' }, { status: 403 }));
    await settle();
    assert.match(N.incompleteNote(), /Refused by gone \(owner_only\)\./, 'a computer the hub no longer lists keeps its id');
    N.readOutcome('questions', 'gone', true);
});
