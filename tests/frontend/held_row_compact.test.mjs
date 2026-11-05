// #13186 (QA Reviewer 2's MUST): the live row's held_messages null means "none held" (a cancel or a send on another screen emptied the list) and a missing key means "not said, keep what you have" (held_sends.js
// syncQueuedFromRow). A compact list (?compact=1) leaves null keys out, so held_messages must stay in it, or a cancelled or sent message stays "Queued". The server keeps it (live_list_compact_test.go); this pins what the
// page does with each shape of row.
//   node held_row_compact.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
document.body.innerHTML = '<div id="composer-queued"></div>';
const { state } = await importUi('state');
const held = await importUi('held_sends');
state.currentSession = { type: 'live', session_id: 's1', name: 'a' };
const lines = () => document.querySelectorAll('#composer-queued .composer-queued-item').length;

held.syncQueuedFromRow({ session_id: 's1', held_messages: [{ id: 1, text: 'one' }] });
assert.equal(lines(), 1, 'a held message is drawn');
held.syncQueuedFromRow({ session_id: 's1' }); // the key is missing: nothing is said, so nothing changes
assert.equal(lines(), 1, 'a row with no held_messages key keeps the list (unknown)');
held.syncQueuedFromRow({ session_id: 's1', held_messages: null }); // what the server says, and what a compact row keeps, when the list was emptied
assert.equal(lines(), 0, 'held_messages null clears the list (none held)');
console.log('held_row_compact: ok');
