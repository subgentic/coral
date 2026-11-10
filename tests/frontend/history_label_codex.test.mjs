// #15012: a Codex rollout's file name is never a chat's title ("Chat rollou" x 12): the first message, else "Codex session, <time>".
import assert from 'node:assert/strict';
import { historyLabel } from '../../coral-go/pkg/frontend/static/history_label.js';

const id = 'rollout-2026-11-09T10-00-00-019e90eb-a08a-7511-a410-000000015012';
assert.equal(historyLabel({ session_id: id, title: 'debug the dashboard feature' }), 'debug the dashboard feature', 'a title is the title');
const none = historyLabel({ session_id: id, title: '', last_timestamp: '2026-11-09T10:30:00Z' });
assert.match(none, /^Codex session, /, none);
assert.doesNotMatch(none, /rollou/i, 'never the file name');
assert.equal(historyLabel({ session_id: id, title: '' }), 'Codex session', 'no time: plain words');
assert.equal(historyLabel({ session_id: '4154e47a-ac42', title: '' }), 'Chat 4154e4', 'another untitled chat is as it was (#6961)');
console.log('history label codex ok');
