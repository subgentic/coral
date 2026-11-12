// #15749: a remote computer's questions showed a bare "could not be read" in the Hub's Needs you. A computer that answers 401/403 refused the Hub's owner (an older Coral does that for the question list, which is only
// signed from generation 9): the note says so and that an update may be needed. A failure that is not a refusal keeps the plain sentence, and this computer's own gap names no computer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const N = await importUi('needs_incomplete'), asks = await importUi('operator_asks'), { state } = await importUi('state');

test('a refused read of a remote names it and says an older Coral may need an update', () => {
    N.readOutcome('questions', 'srv1', false, true);
    assert.match(N.incompleteNote(), /questions from srv1 could not be read\. srv1 refused: an older Coral there may need an update\./);
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
    assert.match(N.incompleteNote(), /srv9 refused: an older Coral there may need an update\./, N.incompleteNote());
});
